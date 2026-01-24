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

async function apiFetch(url, token, opts = {}) {
	const res = await fetch(url, {
		...opts,
		headers: {
			...(opts.headers || {}),
			Authorization: `Bearer ${token}`
		}
	});
	if (res.status === 401) throw new Error("unauthorized");
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res;
}

async function inferFrame(token, jpegBlob, conf = 0.25) {
	const fd = new FormData();
	fd.append("file", jpegBlob, "frame.jpg");
	fd.append("conf", String(conf));
	const res = await apiFetch(`${API_BASE}/predict_frame_fast`, token, {
		method: "POST",
		body: fd
	});
	return res.json();
}

function Chip({label, value}) {
	return (
		<div className="px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white/80 text-xs sm:text-sm flex items-center gap-2">
			<span className="text-white/60">{label}</span>
			<span className="text-white font-semibold">{value}</span>
		</div>
	);
}

function LiveCamsPage() {
	const {token, logout} = useAuth();

	const [cams, setCams] = useState([]);
	const [error, setError] = useState(null);

	const delaySec = 3;

	const [focusCamId, setFocusCamId] = useState(null);

	const [gridUrls, setGridUrls] = useState({});
	const gridBuffersRef = useRef({});

	const focusBuffersRef = useRef([]);
	const focusLastDetRef = useRef({ts: 0, dets: [], conf: 0.25, inferMs: 0});
	const focusInFlightRef = useRef(false);

	const focusCanvasRef = useRef(null);
	const focusOverlayRef = useRef(null);

	const listPollMs = 1000;
	const gridPollMs = 140;

	const focusSnapMs = 90;
	const focusInferMinMs = 230;

	const keepMsGrid = useMemo(() => (delaySec + 8) * 1000, []);
	const keepMsFocus = useMemo(() => (delaySec + 10) * 1000, []);

	const cleanupRemovedCams = activeSet => {
		for (const camId of Object.keys(gridBuffersRef.current)) {
			if (!activeSet.has(camId)) {
				const buf = gridBuffersRef.current[camId] || [];
				for (const it of buf) {
					try {
						URL.revokeObjectURL(it.url);
					} catch {}
				}
				delete gridBuffersRef.current[camId];
				setGridUrls(m => {
					const n = {...m};
					delete n[camId];
					return n;
				});
			}
		}
	};

	const pickForDelay = buf => {
		if (!buf || buf.length === 0) return null;
		const target = Date.now() - delaySec * 1000;
		for (let i = buf.length - 1; i >= 0; i--) {
			if (buf[i].ts <= target) return buf[i];
		}
		return buf[buf.length - 1];
	};

	useEffect(() => {
		if (!token) return;

		let stopped = false;
		let timer = null;

		const tick = async () => {
			try {
				const res = await apiFetch(`${API_BASE}/cams`, token);
				const data = await res.json();
				if (stopped) return;

				const list = data.cams || [];
				setCams(list);
				setError(null);

				const ids = new Set(list.map(c => c.cam_id));
				cleanupRemovedCams(ids);

				if (focusCamId && !ids.has(focusCamId)) setFocusCamId(null);
			} catch (e) {
				if (String(e?.message || e) === "unauthorized") {
					logout?.();
					return;
				}
				setError(String(e?.message || e));
			} finally {
				if (!stopped) timer = setTimeout(tick, listPollMs);
			}
		};

		tick();

		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [token, logout, focusCamId]);

	useEffect(() => {
		if (!token) return;
		if (focusCamId) return;

		let stopped = false;
		const ids = [];

		const start = camId => {
			const update = async () => {
				try {
					const res = await apiFetch(`${API_BASE}/cams/${encodeURIComponent(camId)}/snapshot.jpg`, token);
					const blob = await res.blob();
					if (stopped) return;

					const now = Date.now();
					const url = URL.createObjectURL(blob);

					if (!gridBuffersRef.current[camId]) gridBuffersRef.current[camId] = [];
					gridBuffersRef.current[camId].push({ts: now, url});

					const buf = gridBuffersRef.current[camId];
					while (buf.length > 0 && now - buf[0].ts > keepMsGrid) {
						const old = buf.shift();
						try {
							URL.revokeObjectURL(old.url);
						} catch {}
					}

					const chosen = pickForDelay(buf);
					if (chosen) setGridUrls(m => ({...m, [camId]: chosen.url}));
				} catch {}
			};

			update();
			const id = setInterval(update, gridPollMs);
			ids.push(id);
		};

		for (const cam of cams) start(cam.cam_id);

		return () => {
			stopped = true;
			for (const id of ids) clearInterval(id);
		};
	}, [cams, token, focusCamId]);

	useEffect(() => {
		if (!token) return;
		if (!focusCamId) return;

		focusBuffersRef.current.forEach(it => {
			try {
				URL.revokeObjectURL(it.url);
			} catch {}
		});
		focusBuffersRef.current = [];
		focusLastDetRef.current = {ts: 0, dets: [], conf: 0.25, inferMs: 0};
		focusInFlightRef.current = false;

		let stopped = false;

		const snapLoop = async () => {
			try {
				const res = await apiFetch(`${API_BASE}/cams/${encodeURIComponent(focusCamId)}/snapshot.jpg`, token);
				const blob = await res.blob();
				if (stopped) return;

				const now = Date.now();
				const url = URL.createObjectURL(blob);

				focusBuffersRef.current.push({ts: now, url, blob});

				while (focusBuffersRef.current.length > 0 && now - focusBuffersRef.current[0].ts > keepMsFocus) {
					const old = focusBuffersRef.current.shift();
					try {
						URL.revokeObjectURL(old.url);
					} catch {}
				}

				const chosen = pickForDelay(focusBuffersRef.current);
				if (chosen) {
					const lastInferAt = focusLastDetRef.current.inferMs || 0;
					const canInfer = !focusInFlightRef.current && now - lastInferAt >= focusInferMinMs;

					if (canInfer) {
						focusInFlightRef.current = true;
						focusLastDetRef.current.inferMs = now;

						const t0 = performance.now();
						inferFrame(token, chosen.blob, 0.25)
							.then(data => {
								const dets = Array.isArray(data?.detections) ? data.detections : [];
								focusLastDetRef.current = {
									ts: chosen.ts,
									dets,
									conf: 0.25,
									inferMs: now,
									latencyMs: Math.round(performance.now() - t0)
								};
							})
							.catch(() => {})
							.finally(() => {
								focusInFlightRef.current = false;
							});
					}
				}
			} catch {}
		};

		const id = setInterval(snapLoop, focusSnapMs);
		snapLoop();

		return () => {
			stopped = true;
			clearInterval(id);
		};
	}, [token, focusCamId]);

	useEffect(() => {
		let alive = true;

		const draw = async () => {
			if (!alive) return;

			const canvas = focusCanvasRef.current;
			const overlay = focusOverlayRef.current;
			if (!canvas || !overlay || !focusCamId) {
				requestAnimationFrame(draw);
				return;
			}

			const chosen = pickForDelay(focusBuffersRef.current);
			if (!chosen) {
				requestAnimationFrame(draw);
				return;
			}

			let bmp = null;
			try {
				bmp = await createImageBitmap(chosen.blob);
			} catch {
				requestAnimationFrame(draw);
				return;
			}

			const w = bmp.width;
			const h = bmp.height;

			if (canvas.width !== w) canvas.width = w;
			if (canvas.height !== h) canvas.height = h;
			if (overlay.width !== w) overlay.width = w;
			if (overlay.height !== h) overlay.height = h;

			const ctx = canvas.getContext("2d");
			ctx.clearRect(0, 0, w, h);
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(bmp, 0, 0, w, h);

			try {
				bmp.close();
			} catch {}

			const octx = overlay.getContext("2d");
			octx.clearRect(0, 0, w, h);

			const det = focusLastDetRef.current;
			const dets = det?.dets || [];

			for (const d of dets) {
				const bn = d?.bbox_norm;
				if (!bn || bn.length !== 4) continue;
				const [x1n, y1n, x2n, y2n] = bn;
				const x1 = x1n * w;
				const y1 = y1n * h;
				const x2 = x2n * w;
				const y2 = y2n * h;

				const col = hashColor(d.class || "?");
				octx.strokeStyle = col;
				octx.lineWidth = 5;
				octx.shadowColor = "rgba(0,0,0,0.6)";
				octx.shadowBlur = 8;
				octx.strokeRect(x1, y1, x2 - x1, y2 - y1);
				octx.shadowBlur = 0;

				const label = `${d.class || "?"} ${((d.confidence || 0) * 100).toFixed(1)}%`;
				octx.font = "20px sans-serif";
				const pad = 8;
				const tw = octx.measureText(label).width;
				const bx = x1;
				const by = Math.max(0, y1 - 34);
				octx.fillStyle = "rgba(0,0,0,0.55)";
				octx.fillRect(bx, by, Math.min(w - bx, tw + pad * 2), 30);
				octx.fillStyle = col;
				octx.fillText(label, bx + pad, by + 22);
			}

			requestAnimationFrame(draw);
		};

		requestAnimationFrame(draw);
		return () => {
			alive = false;
		};
	}, [focusCamId]);

	useEffect(() => {
		return () => {
			for (const camId of Object.keys(gridBuffersRef.current)) {
				const buf = gridBuffersRef.current[camId] || [];
				for (const it of buf) {
					try {
						URL.revokeObjectURL(it.url);
					} catch {}
				}
			}
			gridBuffersRef.current = {};
			focusBuffersRef.current.forEach(it => {
				try {
					URL.revokeObjectURL(it.url);
				} catch {}
			});
			focusBuffersRef.current = [];
		};
	}, []);

	const camsSorted = useMemo(() => {
		const list = [...cams];
		list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
		return list;
	}, [cams]);

	const focusCam = focusCamId ? camsSorted.find(c => c.cam_id === focusCamId) : null;
	const focusStats = focusLastDetRef.current;

	if (focusCamId) {
		const headerH = 92;
		const videoH = `calc(100vh - ${headerH}px)`;
		const videoW = `min(100vw, calc((100vh - ${headerH}px) * 16 / 9))`;

		return (
			<div className="fixed inset-0 z-50 bg-slate-950">
				<div className="absolute inset-0 pointer-events-none">
					<div className="absolute -top-40 -left-40 w-[520px] h-[520px] rounded-full bg-white/10 blur-3xl" />
					<div className="absolute -bottom-40 -right-40 w-[520px] h-[520px] rounded-full bg-white/10 blur-3xl" />
					<div className="absolute inset-0 bg-gradient-to-b from-white/[0.06] via-transparent to-black/30" />
				</div>

				<div className="w-full h-full flex flex-col">
					<div className="h-[92px] px-4 sm:px-6 flex items-center justify-between border-b border-white/10 bg-slate-950/60 backdrop-blur">
						<div className="flex items-center gap-3">
							<button onClick={() => setFocusCamId(null)} className="px-4 py-2 rounded-xl bg-white/10 text-white text-sm hover:bg-white/15 border border-white/10">
								← Tornar
							</button>

							<div className="flex flex-col leading-tight">
								<div className="text-white font-semibold text-lg sm:text-xl">{focusCamId}</div>
								<div className="text-white/60 text-xs sm:text-sm">Mode focus · Detecció activa</div>
							</div>
						</div>

						<div className="hidden lg:flex items-center gap-2">
							<Chip label="Deteccions" value={(focusStats?.dets || []).length} />
							<Chip label="Infer ms" value={focusStats?.latencyMs ?? "-"} />
							<Chip label="Delay" value="3s" />
							<Chip label="Last" value={focusCam ? `${focusCam.last_seen_sec}s` : "-"} />
						</div>

						<div className="lg:hidden flex items-center gap-2">
							<div className="px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white text-xs">
								{(focusStats?.dets || []).length} det · {focusStats?.latencyMs ?? "-"}ms
							</div>
						</div>
					</div>

					<div className="flex-1 w-full flex items-center justify-center px-2 sm:px-6">
						<div
							className="relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl"
							style={{
								height: videoH,
								width: videoW,
								maxWidth: "100vw",
								background: "rgba(0,0,0,0.35)"
							}}>
							<canvas ref={focusCanvasRef} className="absolute inset-0 w-full h-full" />
							<canvas ref={focusOverlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />

							<div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
								<div className="px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white/80 text-xs sm:text-sm backdrop-blur">
									Delay fix: <span className="text-white font-semibold">3s</span> · Render fluid (canvas)
								</div>
								<div className="px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white/80 text-xs sm:text-sm backdrop-blur">{focusCam ? `Last: ${focusCam.last_seen_sec}s` : "Last: -"}</div>
							</div>
						</div>
					</div>

					<div className="h-10" />
				</div>
			</div>
		);
	}

	return (
		<div className="max-w-7xl mx-auto px-3 sm:px-6">
			<div className="rounded-2xl bg-white/85 border border-white/60 shadow p-4 sm:p-6">
				<div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 mb-4">
					<div>
						<h2 className="text-2xl sm:text-3xl font-bold text-slate-800">Live Cams</h2>
						<p className="text-sm text-slate-600">Delay fix de 3s. Clica una càmera per veure-la quasi a pantalla completa (detecció en focus).</p>
					</div>

					<div className="text-sm text-slate-700">
						Actives: <span className="font-semibold">{camsSorted.length}</span>
					</div>
				</div>

				{error && <div className="mb-4 p-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm">Error: {error}</div>}

				{camsSorted.length === 0 ? (
					<div className="p-6 rounded-xl bg-white/70 border">
						<div className="text-slate-800 font-semibold">No hi ha càmeres actives ara mateix.</div>
						<div className="text-slate-600 text-sm mt-1">Quan una càmera enviï frames al backend, apareixerà aquí automàticament.</div>
					</div>
				) : (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
						{camsSorted.map(cam => {
							const camId = cam.cam_id;
							const src = gridUrls[camId];
							return (
								<button key={camId} onClick={() => setFocusCamId(camId)} className="text-left rounded-2xl overflow-hidden border bg-white/90 shadow-sm hover:shadow-md transition">
									<div className="px-5 py-4 flex items-center justify-between">
										<div className="text-lg font-semibold text-slate-800">{camId}</div>
										<div className="text-sm text-slate-600">last: {cam.last_seen_sec}s</div>
									</div>

									<div className="bg-black">
										<div className="relative" style={{aspectRatio: "16 / 9"}}>
											{src ? <img src={src} alt={`Live cam ${camId}`} className="absolute inset-0 w-full h-full object-contain" /> : <div className="absolute inset-0 w-full h-full flex items-center justify-center text-slate-200 text-sm">Carregant…</div>}
										</div>
									</div>

									<div className="px-5 py-4 text-sm text-slate-600 flex items-center justify-between">
										<span>Click per centrar (detecció en focus)</span>
										<span className="font-medium">Delay: 3s</span>
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

export default LiveCamsPage;
