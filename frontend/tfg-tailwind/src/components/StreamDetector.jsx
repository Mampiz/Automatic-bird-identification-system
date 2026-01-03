import {useEffect, useMemo, useRef, useState} from "react";
import {useAuth} from "../auth/AuthContext";
import {API_BASE} from "../lib/api";

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

	// 🔥 ENDPOINT CORRECTO PARA STREAMING
	const API_PREDICT = `${API_BASE}/predict_frame_fast`;

	const videoRef = useRef(null);
	const overlayRef = useRef(null);
	const captureRef = useRef(null);
	const streamRef = useRef(null);

	const inFlightRef = useRef(false);
	const lastSentRef = useRef(0);

	const [running, setRunning] = useState(false);
	const [error, setError] = useState("");
	const [conf, setConf] = useState(0.25);
	const [intervalMs, setIntervalMs] = useState(300);
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
		setDetections([]);
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

	// 🎨 DIBUJAR OVERLAY USANDO bbox_norm
	const drawOverlay = () => {
		const v = videoRef.current;
		const canvas = overlayRef.current;
		if (!v || !canvas) return;

		const w = v.videoWidth;
		const h = v.videoHeight;
		if (!w || !h) return;

		if (canvas.width !== w) canvas.width = w;
		if (canvas.height !== h) canvas.height = h;

		const ctx = canvas.getContext("2d");
		ctx.clearRect(0, 0, w, h);

		for (const det of detections) {
			const [x1n, y1n, x2n, y2n] = det.bbox_norm;
			const x1 = x1n * w;
			const y1 = y1n * h;
			const x2 = x2n * w;
			const y2 = y2n * h;

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

	useEffect(drawOverlay, [detections]);

	// 🚀 LOOP DE INFERENCIA CORRECTO (SIN COLAS)
	useEffect(() => {
		if (!running || !token) return;

		let alive = true;

		const loop = async () => {
			if (!alive) return;

			const now = Date.now();
			if (inFlightRef.current || now - lastSentRef.current < intervalMs) {
				requestAnimationFrame(loop);
				return;
			}

			const v = videoRef.current;
			const cap = captureRef.current;
			if (!v || !cap) {
				requestAnimationFrame(loop);
				return;
			}

			const w = v.videoWidth;
			const h = v.videoHeight;
			if (!w || !h) {
				requestAnimationFrame(loop);
				return;
			}

			cap.width = w;
			cap.height = h;
			cap.getContext("2d").drawImage(v, 0, 0, w, h);

			inFlightRef.current = true;
			lastSentRef.current = now;

			const t0 = performance.now();
			const blob = await new Promise(r => cap.toBlob(r, "image/jpeg", 0.7));
			if (!blob) {
				inFlightRef.current = false;
				requestAnimationFrame(loop);
				return;
			}

			const form = new FormData();
			form.append("file", blob);
			form.append("conf", conf.toString());

			try {
				const res = await fetch(API_PREDICT, {
					method: "POST",
					headers: {Authorization: `Bearer ${token}`},
					body: form
				});
				const data = await res.json();

				if (!alive) return;
				setDetections(data.detections || []);

				const ms = performance.now() - t0;
				setStats({
					lastMs: Math.round(ms),
					fps: ms > 0 ? Math.round(1000 / ms) : 0
				});
			} catch (e) {
				if (alive) setError(e.message || "Error en streaming");
			} finally {
				inFlightRef.current = false;
				requestAnimationFrame(loop);
			}
		};

		requestAnimationFrame(loop);
		return () => {
			alive = false;
		};
	}, [running, token, conf, intervalMs]);

	useEffect(() => stopCamera, []);

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

			{error && <div className="mt-3 mx-auto max-w-3xl rounded-2xl border border-rose-100 bg-rose-50/90 px-4 py-2 text-sm text-rose-700">{error}</div>}

			<div className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[96%] sm:w-[80%] lg:w-[60%] rounded-3xl border border-slate-100 bg-white/90 shadow-2xl px-5 py-4 backdrop-blur z-50">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<button onClick={running ? stopCamera : startCamera} className={`px-4 py-2 rounded-full text-xs sm:text-sm font-semibold text-white ${running ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>
						{running ? "Aturar" : "Activar càmera"}
					</button>

					<div className="flex gap-3 text-xs text-slate-600">
						<div className="rounded-full bg-slate-50 border px-3 py-2">
							{stats.lastMs} ms · ~{stats.fps} fps
						</div>
						<div className="rounded-full bg-slate-50 border px-3 py-2">Deteccions: {detections.length}</div>
					</div>
				</div>

				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					<div className="space-y-1 text-xs">
						<span>Confiança mínima: {Math.round(conf * 100)}%</span>
						<input type="range" min="0.1" max="0.9" step="0.05" value={conf} onChange={e => setConf(+e.target.value)} className="w-full accent-emerald-600" />
					</div>
					<div className="space-y-1 text-xs">
						<span>Interval: {intervalMs} ms</span>
						<input type="range" min="200" max="1000" step="50" value={intervalMs} onChange={e => setIntervalMs(+e.target.value)} className="w-full accent-indigo-600" />
					</div>
				</div>
			</div>
		</main>
	);
}
