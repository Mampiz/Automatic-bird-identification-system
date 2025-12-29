import {useEffect, useMemo, useRef, useState} from "react";
import {useAuth} from "../auth/AuthContext";
import { API_BASE } from "../lib/api";

function hashColor(str) {
	let h = 0;
	for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
	const r = 80 + ((h & 0xff) % 176);
	const g = 80 + (((h >>> 8) & 0xff) % 176);
	const b = 80 + (((h >>> 16) & 0xff) % 176);
	return `rgb(${r},${g},${b})`;
}

export default function StreamDetector() {
	const {token} = useAuth();

	const API_PREDICT = `${API_BASE}/predict_frame`;

	const videoRef = useRef(null);
	const overlayRef = useRef(null);
	const captureRef = useRef(null);
	const streamRef = useRef(null);

	const [running, setRunning] = useState(false);
	const [error, setError] = useState("");
	const [conf, setConf] = useState(0.25);
	const [intervalMs, setIntervalMs] = useState(200);
	const [detections, setDetections] = useState([]);
	const [stats, setStats] = useState({fps: 0, lastMs: 0});

	const topSpecies = useMemo(() => {
		const counts = new Map();
		for (const d of detections) counts.set(d.class, (counts.get(d.class) || 0) + 1);
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([sp, cnt]) => ({sp, cnt}));
	}, [detections]);

	const stopCamera = () => {
		try {
			if (streamRef.current) {
				streamRef.current.getTracks().forEach(t => t.stop());
				streamRef.current = null;
			}
		} catch {}
		setRunning(false);
	};

	const startCamera = async () => {
		setError("");
		if (!token) return setError("No estás autenticado. Haz login primero.");

		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				video: {facingMode: "environment"},
				audio: false
			});
			streamRef.current = stream;

			if (videoRef.current) {
				videoRef.current.srcObject = stream;
				await videoRef.current.play();
			}
			setRunning(true);
		} catch (e) {
			setError(e?.message || "No se pudo acceder a la cámara.");
		}
	};

	const drawOverlay = () => {
		const v = videoRef.current;
		const canvas = overlayRef.current;
		if (!v || !canvas) return;

		const w = v.videoWidth || 0;
		const h = v.videoHeight || 0;
		if (!w || !h) return;

		if (canvas.width !== w) canvas.width = w;
		if (canvas.height !== h) canvas.height = h;

		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, w, h);

		for (const det of detections) {
			const [x1, y1, x2, y2] = det.bbox;
			const col = hashColor(det.class);

			ctx.strokeStyle = col;
			ctx.lineWidth = 4;
			ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

			const label = `${det.class} ${(det.confidence * 100).toFixed(1)}%`;
			ctx.font = "18px sans-serif";
			ctx.fillStyle = col;
			ctx.fillText(label, x1 + 6, Math.max(22, y1 - 8));
		}
	};

	useEffect(() => {
		drawOverlay();
		
	}, [detections]);

	
	useEffect(() => {
		if (!running || !token) return;

		let alive = true;
		let timer = null;

		const tick = async () => {
			const v = videoRef.current;
			const cap = captureRef.current;
			if (!v || !cap) return;

			const w = v.videoWidth;
			const h = v.videoHeight;
			if (!w || !h) return;

			if (cap.width !== w) cap.width = w;
			if (cap.height !== h) cap.height = h;

			const cctx = cap.getContext("2d");
			cctx.drawImage(v, 0, 0, w, h);

			const t0 = performance.now();

			const blob = await new Promise(resolve => cap.toBlob(resolve, "image/jpeg", 0.75));
			if (!blob) return;

			const form = new FormData();
			form.append("file", blob, "frame.jpg");
			form.append("conf", conf.toString());

			try {
				const res = await fetch(API_PREDICT, {
					method: "POST",
					headers: {Authorization: `Bearer ${token}`},
					body: form
				});
				const data = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(data.detail || "Error en predict_frame");

				if (!alive) return;

				setDetections(data.detections || []);

				const t1 = performance.now();
				const ms = t1 - t0;
				setStats({
					lastMs: Math.round(ms),
					fps: ms > 0 ? Math.min(60, Math.round(1000 / ms)) : 0
				});
			} catch (e) {
				if (!alive) return;
				setError(e.message || "Error desconocido");
			}
		};

		timer = setInterval(tick, Math.max(120, intervalMs));

		return () => {
			alive = false;
			if (timer) clearInterval(timer);
		};
	}, [running, token, conf, intervalMs]);

	useEffect(() => {
		return () => stopCamera();

	}, []);

	return (
		
		<main className="w-screen min-h-[calc(100vh-120px)] px-2 sm:px-4 pb-28">
			
			<div className="relative w-screen -mx-2 sm:-mx-4">
				<div className="relative w-screen h-[92vh] bg-black/10 border-y border-white/50">
					<video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline muted />
					<canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
					<canvas ref={captureRef} className="hidden" />

					{!running && (
						<div className="absolute inset-0 flex items-center justify-center text-white">
							<div className="rounded-2xl bg-black/60 px-5 py-4 text-sm">Activa la càmera per començar.</div>
						</div>
					)}
				</div>
			</div>

			
			{error && <div className="mt-3 mx-auto max-w-3xl rounded-2xl border border-rose-100 bg-rose-50/90 px-4 py-2 text-sm text-rose-700"> {error}</div>}

			<div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[96%] sm:w-[80%] lg:w-[60%] rounded-3xl border border-slate-100 bg-white/90 shadow-2xl px-5 py-4 backdrop-blur z-50">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						{!running ? (
							<button onClick={startCamera} className="px-4 py-2 rounded-full bg-emerald-600 text-white text-xs sm:text-sm font-semibold hover:bg-emerald-700">
								Activar càmera
							</button>
						) : (
							<button onClick={stopCamera} className="px-4 py-2 rounded-full bg-rose-600 text-white text-xs sm:text-sm font-semibold hover:bg-rose-700">
								Aturar
							</button>
						)}
					</div>

					<div className="flex flex-wrap gap-3 text-xs text-slate-600">
						<div className="rounded-full bg-slate-50 border border-slate-100 px-3 py-2">
							<span className="font-semibold">Inferència:</span> {stats.lastMs} ms · ~{stats.fps} fps
						</div>
						<div className="rounded-full bg-slate-50 border border-slate-100 px-3 py-2">
							<span className="font-semibold">Deteccions:</span> {detections.length}
						</div>
					</div>
				</div>

				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					<div className="space-y-1 text-xs text-slate-600">
						<div className="flex items-center justify-between">
							<span className="font-medium">Confiança mínima</span>
							<span className="font-semibold text-emerald-700">{Math.round(conf * 100)}%</span>
						</div>
						<input type="range" min="0.1" max="0.9" step="0.05" value={conf} onChange={e => setConf(parseFloat(e.target.value))} className="w-full accent-emerald-600" />
					</div>

					<div className="space-y-1 text-xs text-slate-600">
						<div className="flex items-center justify-between">
							<span className="font-medium">Interval (ms)</span>
							<span className="font-semibold text-indigo-700">{intervalMs}</span>
						</div>
						<input type="range" min="120" max="1000" step="10" value={intervalMs} onChange={e => setIntervalMs(parseInt(e.target.value, 10))} className="w-full accent-indigo-600" />
					</div>
				</div>

				{topSpecies.length > 0 && (
					<div className="mt-4 flex flex-wrap gap-2">
						{topSpecies.map(x => (
							<span key={x.sp} className="inline-flex items-center gap-2 rounded-full bg-white border border-slate-100 px-3 py-2 text-xs text-slate-700">
								<span className="inline-block w-3 h-3 rounded-sm" style={{background: hashColor(x.sp)}} />
								<span className="font-semibold">{x.sp}</span>
								<span className="text-slate-400">({x.cnt})</span>
							</span>
						))}
					</div>
				)}
			</div>
		</main>
	);
}
