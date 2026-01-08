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

function StatPill({label, value}) {
	return (
		<div className="rounded-2xl border border-slate-200/70 bg-white/85 px-3 py-2 shadow-sm backdrop-blur">
			<div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
			<div className="text-sm font-extrabold text-slate-800">{value}</div>
		</div>
	);
}

function Section({title, children, right}) {
	return (
		<div className="rounded-3xl border border-slate-200/70 bg-white/85 shadow-xl backdrop-blur p-4">
			<div className="flex items-center justify-between gap-3">
				<h3 className="text-sm font-extrabold text-slate-900">{title}</h3>
				{right}
			</div>
			<div className="mt-3">{children}</div>
		</div>
	);
}

export default function StreamDetector() {
	const {token} = useAuth();
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
			.slice(0, 5)
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

	// Overlay bbox_norm
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

	// Loop inferència
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

	// Classe Tailwind per amagar scrollbar (segueix fent scroll)
	const hideScrollbar = "overflow-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";

	return (
		<main className="w-screen min-h-[calc(100vh-120px)]">
			<div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 px-3 sm:px-6 py-4">
				{/* VIDEO (max gran) */}
				<div className="relative">
					<div className="relative overflow-hidden rounded-[28px] border border-white/60 bg-black/10 shadow-2xl">
						<div className="relative h-[82vh] lg:h-[calc(100vh-160px)]">
							<video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline muted />
							<canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
							<canvas ref={captureRef} className="hidden" />

							{!running && (
								<div className="absolute inset-0 grid place-items-center p-6">
									<div className="max-w-md w-full rounded-3xl border border-white/60 bg-white/80 backdrop-blur-xl shadow-2xl p-6 text-center">
										<div className="text-lg font-extrabold text-slate-900">Mode directe</div>
										<p className="text-sm text-slate-600 mt-1">Activa la càmera per començar la detecció en temps real.</p>
										<div className="mt-4 flex justify-center">
											<button onClick={startCamera} className="rounded-2xl bg-emerald-600 px-5 py-3 text-sm font-extrabold text-white shadow hover:bg-emerald-700 active:scale-[0.99] transition">
												Activar càmera
											</button>
										</div>
									</div>
								</div>
							)}

							{/* Etiquetes discretes */}
							<div className="absolute top-3 left-3 flex flex-wrap gap-2">
								<span className="inline-flex items-center gap-2 rounded-full border border-white/60 bg-white/70 px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur">Directe</span>
								<span className="inline-flex items-center gap-2 rounded-full border border-white/60 bg-white/70 px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur">
									<span className={`h-2 w-2 rounded-full ${running ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} />
									{running ? "En execució" : "Aturat"}
								</span>
							</div>
						</div>
					</div>

					{error && (
						<div className="mt-3 rounded-2xl border border-rose-200/60 bg-rose-50/90 px-4 py-3 text-sm text-rose-700">
							<span className="font-semibold">Error</span>
							<div className="text-xs mt-1">{error}</div>
						</div>
					)}
				</div>

				{/* PANEL LATERAL */}
				<aside className="lg:sticky lg:top-4 h-fit space-y-4">
					<Section
						title="Controls"
						right={
							<button
								onClick={running ? stopCamera : startCamera}
								className={`px-4 py-2 rounded-full text-xs font-extrabold text-white shadow transition active:scale-[0.99]
									${running ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>
								{running ? "Aturar" : "Activar càmera"}
							</button>
						}>
						<div className="grid grid-cols-3 gap-2">
							<StatPill label="Latència" value={`${stats.lastMs} ms`} />
							<StatPill label="FPS" value={`~${stats.fps}`} />
							<StatPill label="Deteccions" value={detections.length} />
						</div>

						<div className="mt-4 space-y-4">
							<div className="space-y-2">
								<div className="flex items-center justify-between text-xs">
									<span className="font-semibold text-slate-700">Confiança mínima</span>
									<span className="font-bold text-slate-900">{Math.round(conf * 100)}%</span>
								</div>
								<input type="range" min="0.1" max="0.9" step="0.05" value={conf} onChange={e => setConf(+e.target.value)} className="w-full accent-emerald-600" />
								<p className="text-[11px] text-slate-500">Puja-ho per reduir falsos positius.</p>
							</div>

							<div className="space-y-2">
								<div className="flex items-center justify-between text-xs">
									<span className="font-semibold text-slate-700">Interval d’enviament</span>
									<span className="font-bold text-slate-900">{intervalMs} ms</span>
								</div>
								<input type="range" min="200" max="1000" step="50" value={intervalMs} onChange={e => setIntervalMs(+e.target.value)} className="w-full accent-indigo-600" />
								<p className="text-[11px] text-slate-500">Més baix = més fluïdesa (i més càrrega).</p>
							</div>
						</div>
					</Section>

					<Section title="Top espècies">
						{topSpecies.length === 0 ? (
							<p className="text-sm text-slate-600">Encara no hi ha dades.</p>
						) : (
							<div className="space-y-2">
								{topSpecies.map(t => {
									const color = hashColor(t.sp);
									return (
										<div key={t.sp} className="flex items-center justify-between rounded-2xl border border-slate-200/70 bg-white/85 px-3 py-2">
											<div className="flex items-center gap-2">
												<span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: color}} />
												<span className="text-sm font-extrabold text-slate-900">{t.sp}</span>
											</div>
											<span className="text-sm font-extrabold" style={{color}}>
												{t.cnt}
											</span>
										</div>
									);
								})}
							</div>
						)}
					</Section>

					<Section title="Deteccions" right={<span className="text-xs font-bold text-slate-600">{detections.length}</span>}>
						{detections.length === 0 ? (
							<p className="text-sm text-slate-600">No hi ha deteccions ara mateix.</p>
						) : (
							<div className={`${hideScrollbar} max-h-[38vh] pr-1 space-y-2`}>
								{detections.map((d, idx) => {
									const color = hashColor(d.class);
									return (
										<div key={`${d.class}-${idx}`} className="rounded-2xl border border-slate-200/70 bg-white/85 px-3 py-2">
											<div className="flex items-center justify-between">
												<div className="flex items-center gap-2">
													<span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: color}} />
													<span className="text-sm font-extrabold text-slate-900">{d.class}</span>
												</div>
												<span className="text-xs font-bold text-slate-700">{(d.confidence * 100).toFixed(1)}%</span>
											</div>

											<div className="mt-2 h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
												<div
													className="h-full rounded-full"
													style={{
														width: `${Math.max(0, Math.min(1, d.confidence)) * 100}%`,
														backgroundColor: color
													}}
												/>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</Section>
				</aside>
			</div>
		</main>
	);
}
