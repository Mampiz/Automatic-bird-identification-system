import Hls from "hls.js";
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

export default function LiveCamsPage() {
	const {token, logout} = useAuth();

	const delaySec = 3;
	const conf = 0.25;
	const intervalMs = 300;

	const [error, setError] = useState("");
	const [streams, setStreams] = useState([]);
	const [focus, setFocus] = useState(null);

	const [playState, setPlayState] = useState("idle");
	const [playErr, setPlayErr] = useState("");

	const videoRef = useRef(null);
	const overlayRef = useRef(null);
	const captureRef = useRef(null);

	const hlsRef = useRef(null);

	const inFlightRef = useRef(false);
	const lastSentRef = useRef(0);

	const [detections, setDetections] = useState([]);
	const [stats, setStats] = useState({lastMs: 0, fps: 0, dets: 0});

	const topSpecies = useMemo(() => {
		const counts = new Map();
		for (const d of detections) counts.set(d.class, (counts.get(d.class) || 0) + 1);
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([sp, cnt]) => ({sp, cnt}));
	}, [detections]);

	useEffect(() => {
		if (!token) return;

		let alive = true;

		const tick = async () => {
			try {
				const res = await apiFetch(`${API_BASE}/live/streams`, token);
				const data = await res.json();
				if (!alive) return;
				setStreams(data.items || []);
				setError("");
			} catch (e) {
				if (String(e?.message || e) === "unauthorized") {
					logout?.();
					return;
				}
				setError(String(e?.message || e));
			}
		};

		tick();
		const id = setInterval(tick, 1200);

		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [token, logout]);

	useEffect(() => {
		const v = videoRef.current;
		if (!v) return;

		const cleanupVideo = () => {
			try {
				v.pause();
				v.removeAttribute("src");
				v.load();
			} catch {}
		};

		if (hlsRef.current) {
			try {
				hlsRef.current.stopLoad();
			} catch {}
			try {
				hlsRef.current.destroy();
			} catch {}
			hlsRef.current = null;
		}

		setPlayState("idle");
		setPlayErr("");

		if (!focus) {
			cleanupVideo();
			return;
		}

		setDetections([]);
		setStats({lastMs: 0, fps: 0, dets: 0});
		setPlayState("loading");
		setPlayErr("");

		const src = focus.m3u8_url;

		const onPlaying = () => {
			setPlayState("playing");
			setPlayErr("");
		};

		const onCanPlay = () => {
			setPlayState(s => (s === "loading" ? "ready" : s));
		};

		const onError = () => {
			setPlayState(s => (s === "playing" ? s : "loading"));
		};

		v.addEventListener("playing", onPlaying);
		v.addEventListener("canplay", onCanPlay);
		v.addEventListener("error", onError);

		const tryPlay = () => {
			setPlayState("ready");
			setTimeout(() => {
				v.play()
					.then(() => {
						setPlayState("playing");
						setPlayErr("");
					})
					.catch(() => {
						setPlayState("ready");
						setPlayErr("Autoplay bloquejat. Prem Play manualment.");
					});
			}, delaySec * 1000);
		};

		if (v.canPlayType("application/vnd.apple.mpegurl")) {
			v.src = src;
			tryPlay();

			return () => {
				v.removeEventListener("playing", onPlaying);
				v.removeEventListener("canplay", onCanPlay);
				v.removeEventListener("error", onError);
				cleanupVideo();
			};
		}

		if (Hls.isSupported()) {
			const hls = new Hls({
				lowLatencyMode: false,
				backBufferLength: 30,
				maxBufferLength: 8,
				liveSyncDurationCount: 3,
				enableWorker: true,
				xhrSetup: xhr => {
					xhr.withCredentials = false;
				}
			});

			hlsRef.current = hls;

			let triedRecoverMedia = false;
			let triedRecoverLevel = false;

			hls.on(Hls.Events.MEDIA_ATTACHED, () => {
				hls.loadSource(src);
				hls.startLoad();
			});

			hls.on(Hls.Events.MANIFEST_PARSED, () => {
				tryPlay();
			});

			hls.on(Hls.Events.ERROR, (_, data) => {
				const fatal = !!data?.fatal;
				const type = data?.type || "";
				const details = data?.details || "";

				if (!fatal) return;

				if (type === Hls.ErrorTypes.NETWORK_ERROR) {
					setPlayState("loading");
					setPlayErr("Reintentant carregar stream...");
					setTimeout(() => {
						try {
							hls.startLoad();
						} catch {}
					}, 600);
					return;
				}

				if (type === Hls.ErrorTypes.MEDIA_ERROR) {
					if (!triedRecoverMedia) {
						triedRecoverMedia = true;
						setPlayState("loading");
						setPlayErr("Recuperant media...");
						setTimeout(() => {
							try {
								hls.recoverMediaError();
							} catch {}
						}, 300);
						return;
					}

					if (!triedRecoverLevel) {
						triedRecoverLevel = true;
						setPlayState("loading");
						setPlayErr("Recuperant codec...");
						setTimeout(() => {
							try {
								hls.swapAudioCodec();
								hls.recoverMediaError();
							} catch {}
						}, 300);
						return;
					}
				}

				setPlayState("error");
				setPlayErr(`${type}: ${details || "fatal"}`);
			});

			hls.attachMedia(v);
		} else {
			setPlayState("error");
			setPlayErr("HLS no suportat en aquest navegador.");
		}

		return () => {
			v.removeEventListener("playing", onPlaying);
			v.removeEventListener("canplay", onCanPlay);
			v.removeEventListener("error", onError);

			if (hlsRef.current) {
				try {
					hlsRef.current.stopLoad();
				} catch {}
				try {
					hlsRef.current.destroy();
				} catch {}
				hlsRef.current = null;
			}
			cleanupVideo();
		};
	}, [focus]);

	useEffect(() => {
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
			const bn = det?.bbox_norm;
			if (!bn || bn.length !== 4) continue;

			const [x1n, y1n, x2n, y2n] = bn;
			const x1 = x1n * w;
			const y1 = y1n * h;
			const x2 = x2n * w;
			const y2 = y2n * h;

			const col = hashColor(det.class || "?");
			ctx.strokeStyle = col;
			ctx.lineWidth = 4;
			ctx.shadowColor = "rgba(0,0,0,0.6)";
			ctx.shadowBlur = 8;
			ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
			ctx.shadowBlur = 0;

			const label = `${det.class || "?"} ${((det.confidence || 0) * 100).toFixed(1)}%`;
			ctx.font = "18px sans-serif";
			const pad = 8;
			const tw = ctx.measureText(label).width;
			const by = Math.max(0, y1 - 30);
			ctx.fillStyle = "rgba(0,0,0,0.55)";
			ctx.fillRect(x1, by, Math.min(w - x1, tw + pad * 2), 26);
			ctx.fillStyle = col;
			ctx.fillText(label, x1 + pad, by + 19);
		}
	}, [detections]);

	useEffect(() => {
		if (!focus || !token) return;

		let alive = true;

		const loop = async () => {
			if (!alive) return;

			const v = videoRef.current;
			const cap = captureRef.current;

			if (!v || !cap) {
				requestAnimationFrame(loop);
				return;
			}

			const w = v.videoWidth;
			const h = v.videoHeight;

			if (!w || !h || playState !== "playing") {
				requestAnimationFrame(loop);
				return;
			}

			const now = Date.now();
			if (inFlightRef.current || now - lastSentRef.current < intervalMs) {
				requestAnimationFrame(loop);
				return;
			}

			cap.width = w;
			cap.height = h;

			try {
				cap.getContext("2d").drawImage(v, 0, 0, w, h);
			} catch {
				requestAnimationFrame(loop);
				return;
			}

			inFlightRef.current = true;
			lastSentRef.current = now;

			const t0 = performance.now();
			const blob = await new Promise(r => cap.toBlob(r, "image/jpeg", 0.75));
			if (!blob) {
				inFlightRef.current = false;
				requestAnimationFrame(loop);
				return;
			}

			try {
				const data = await inferFrame(token, blob, conf);
				if (!alive) return;

				const dets = Array.isArray(data?.detections) ? data.detections : [];
				setDetections(dets);

				const ms = performance.now() - t0;
				setStats({
					lastMs: Math.round(ms),
					fps: ms > 0 ? Math.round(1000 / ms) : 0,
					dets: dets.length
				});
			} catch (e) {
				if (alive) setError(e?.message || "Error inferència");
			} finally {
				inFlightRef.current = false;
				requestAnimationFrame(loop);
			}
		};

		requestAnimationFrame(loop);
		return () => {
			alive = false;
		};
	}, [focus, token, playState]);

	if (focus) {
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
							<button onClick={() => setFocus(null)} className="px-4 py-2 rounded-xl bg-white/10 text-white text-sm hover:bg-white/15 border border-white/10">
								← Tornar
							</button>

							<div className="flex flex-col leading-tight">
								<div className="text-white font-semibold text-lg sm:text-xl">{focus.id}</div>
								<div className="text-white/60 text-xs sm:text-sm">HLS · Detecció activa</div>
							</div>
						</div>

						<div className="hidden lg:flex items-center gap-2">
							<Chip label="Estat" value={playState} />
							<Chip label="Deteccions" value={stats.dets} />
							<Chip label="Infer ms" value={stats.lastMs || "-"} />
							<Chip label="Delay" value="3s" />
						</div>

						<div className="lg:hidden flex items-center gap-2">
							<div className="px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white text-xs">
								{playState} · {stats.dets} det
							</div>
						</div>
					</div>

					<div className="flex-1 w-full flex items-center justify-center px-2 sm:px-6">
						<div className="relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl" style={{height: videoH, width: videoW, maxWidth: "100vw"}}>
							<video ref={videoRef} className="absolute inset-0 w-full h-full object-contain" playsInline muted autoPlay controls crossOrigin="anonymous" />
							<canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
							<canvas ref={captureRef} className="hidden" />

							<div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2">
								<div className="px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white/80 text-xs sm:text-sm backdrop-blur">
									{playState === "loading" ? "Carregant stream..." : playState === "playing" ? "Reproduint" : playState === "ready" ? "Llesta (prem Play si cal)" : "Error"}
									{playErr ? ` · ${playErr}` : ""}
								</div>

								<div className="px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white/80 text-xs sm:text-sm backdrop-blur">{focus.m3u8_url}</div>
							</div>

							<div className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2">
								<div className="px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white/80 text-xs sm:text-sm backdrop-blur">
									Delay fix: <span className="text-white font-semibold">3s</span>
								</div>

								<div className="px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white/80 text-xs sm:text-sm backdrop-blur">Top: {topSpecies.length ? topSpecies.map(t => `${t.sp}(${t.cnt})`).join(" · ") : "—"}</div>
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
				<div className="flex items-end justify-between gap-4 mb-4">
					<div>
						<h2 className="text-2xl sm:text-3xl font-bold text-slate-800">Live Cams (HLS)</h2>
						<p className="text-sm text-slate-600">RTMP → nginx-rtmp → HLS (.m3u8). Delay fix de 3s. Detecció només en focus.</p>
					</div>
					<div className="text-sm text-slate-700">
						Disponibles: <span className="font-semibold">{streams.length}</span>
					</div>
				</div>

				{error && <div className="mb-4 p-3 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm">Error: {error}</div>}

				{streams.length === 0 ? (
					<div className="p-6 rounded-xl bg-white/70 border">
						<div className="text-slate-800 font-semibold">No hi ha streams HLS detectats.</div>
						<div className="text-slate-600 text-sm mt-1">
							Assegura’t que nginx està generant fitxers <code>.m3u8</code> al volum compartit.
						</div>
					</div>
				) : (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
						{streams.map(s => (
							<button key={s.id} onClick={() => setFocus(s)} className="text-left rounded-2xl overflow-hidden border bg-white/90 shadow-sm hover:shadow-md transition">
								<div className="px-5 py-4 flex items-center justify-between">
									<div className="text-lg font-semibold text-slate-800">{s.id}</div>
									<div className="text-sm text-slate-600">HLS</div>
								</div>

								<div className="px-5 pb-5 text-sm text-slate-600">
									<div className="font-semibold text-slate-700">m3u8</div>
									<div className="break-all">{s.m3u8_url}</div>

									<div className="mt-3 flex items-center justify-between">
										<span className="text-xs text-slate-500">Click per obrir (detecció en focus)</span>
										<span className="text-xs font-semibold text-slate-700">Delay: 3s</span>
									</div>
								</div>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
