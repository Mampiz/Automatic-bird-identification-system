import {useEffect, useRef, useState} from "react";
import {useAuth} from "../auth/AuthContext";
import {API_BASE} from "../lib/api";

function VideoDetector() {
	const {token} = useAuth();

	const [selectedFile, setSelectedFile] = useState(null);
	const [previewUrl, setPreviewUrl] = useState(null);

	const [jobId, setJobId] = useState(null);
	const [jobState, setJobState] = useState(null);
	const [progress, setProgress] = useState(0);
	const [statusMsg, setStatusMsg] = useState("");

	const [result, setResult] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	const [conf, setConf] = useState(0.25);
	const [stride, setStride] = useState(5);

	// MP4 anotat
	const [annotatedBlobUrl, setAnnotatedBlobUrl] = useState(null);

	const [playbackRate, setPlaybackRate] = useState(1.0);

	// Publicar
	const [showPublish, setShowPublish] = useState(false);
	const [pubTitle, setPubTitle] = useState("");
	const [pubDesc, setPubDesc] = useState("");
	const [publishing, setPublishing] = useState(false);
	const [publishedOk, setPublishedOk] = useState(false);

	const videoRef = useRef(null);
	const annotatedVideoRef = useRef(null);

	const API_START = `${API_BASE}/predict_video_annotated`;
	const API_STATUS = id => `${API_BASE}/status/${id}`;

	const absApiUrl = maybeUrl => {
		if (!maybeUrl) return null;
		if (maybeUrl.startsWith("http://") || maybeUrl.startsWith("https://")) return maybeUrl;
		return `${API_BASE}${maybeUrl.startsWith("/") ? "" : "/"}${maybeUrl}`;
	};

	useEffect(() => {
		return () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		};
	}, [previewUrl]);

	useEffect(() => {
		return () => {
			if (annotatedBlobUrl) URL.revokeObjectURL(annotatedBlobUrl);
		};
	}, [annotatedBlobUrl]);

	useEffect(() => {
		if (annotatedVideoRef.current) annotatedVideoRef.current.playbackRate = playbackRate;
	}, [playbackRate]);

	const handleFileChange = e => {
		const file = e.target.files[0];
		setSelectedFile(file);

		setError("");
		setResult(null);
		setJobId(null);
		setJobState(null);
		setProgress(0);
		setStatusMsg("");
		setPublishedOk(false);
		setShowPublish(false);

		if (previewUrl) URL.revokeObjectURL(previewUrl);
		if (file) setPreviewUrl(URL.createObjectURL(file));
		else setPreviewUrl(null);

		if (annotatedBlobUrl) URL.revokeObjectURL(annotatedBlobUrl);
		setAnnotatedBlobUrl(null);
	};

	const formatTime = seconds => {
		if (seconds == null || isNaN(seconds)) return "-";
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	};

	const handleSubmit = async e => {
		e.preventDefault();

		if (!token) {
			setError("No estás autenticado. Haz login primero.");
			return;
		}

		if (!selectedFile) {
			setError("Selecciona primero un vídeo.");
			return;
		}

		setLoading(true);
		setError("");
		setResult(null);
		setJobId(null);
		setJobState("queued");
		setProgress(0);
		setStatusMsg("Enviando vídeo...");
		setPublishedOk(false);
		setShowPublish(false);

		if (annotatedBlobUrl) URL.revokeObjectURL(annotatedBlobUrl);
		setAnnotatedBlobUrl(null);

		try {
			const formData = new FormData();
			formData.append("file", selectedFile);
			formData.append("conf", conf.toString());
			formData.append("stride", stride.toString());

			const res = await fetch(API_START, {
				method: "POST",
				headers: {Authorization: `Bearer ${token}`},
				body: formData
			});

			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(data.detail || data.error || "Error iniciando análisis");
			}

			setJobId(data.job_id);
			setStatusMsg(data.cached ? "Resultado en caché. Cargando..." : "Procesando...");
		} catch (err) {
			console.error(err);
			setError(err.message || "Error desconocido");
			setLoading(false);
		}
	};

	// Poll status
	useEffect(() => {
		if (!jobId) return;
		if (!token) return;

		let alive = true;

		const interval = setInterval(async () => {
			try {
				const res = await fetch(API_STATUS(jobId), {
					headers: {Authorization: `Bearer ${token}`}
				});
				const st = await res.json().catch(() => ({}));

				if (!res.ok) {
					if (st?.detail) setError(st.detail);
					return;
				}
				if (!alive) return;

				setJobState(st.state);
				setProgress(st.progress ?? 0);
				setStatusMsg(st.message ?? "");

				if (st.state === "done") {
					setResult(st.result);
					setLoading(false);
					clearInterval(interval);

					if (st.result?.video_url) {
						const videoUrl = absApiUrl(st.result.video_url);

						const vres = await fetch(videoUrl, {
							headers: {Authorization: `Bearer ${token}`}
						});
						if (!vres.ok) {
							throw new Error("No se pudo descargar el MP4 anotado (auth).");
						}
						const blob = await vres.blob();
						const url = URL.createObjectURL(blob);
						if (annotatedBlobUrl) URL.revokeObjectURL(annotatedBlobUrl);
						setAnnotatedBlobUrl(url);

						setTimeout(() => {
							annotatedVideoRef.current?.load();
							if (annotatedVideoRef.current) annotatedVideoRef.current.playbackRate = playbackRate;
						}, 0);
					}
				}

				if (st.state === "error") {
					setError(st.error || "Error desconocido");
					setLoading(false);
					clearInterval(interval);
				}
			} catch (err) {
				console.error(err);
				setError(err.message || "Error desconocido");
				setLoading(false);
				clearInterval(interval);
			}
		}, 800);

		return () => {
			alive = false;
			clearInterval(interval);
		};
	}, [jobId, token]); // eslint-disable-line react-hooks/exhaustive-deps

	const totalDuration = result?.video_info?.duration_seconds ?? null;

	return (
		<main className="bg-white/80 backdrop-blur-xl border border-white/70 shadow-xl rounded-3xl p-6 sm:p-8 lg:p-10 flex flex-col gap-8 w-full mx-auto">
			<div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,2.1fr)] items-start">
				<section className="space-y-6">
					<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
						<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">1</span>
						Carrega el teu vídeo
					</h2>

					<form onSubmit={handleSubmit} className="space-y-4">
						<label htmlFor="file-video" className="flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center cursor-pointer transition hover:border-indigo-300 hover:bg-indigo-50/60">
							<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm">
								<span className="text-2xl">🎬</span>
							</div>
							<div className="space-y-1">
								<p className="text-sm font-medium text-slate-900">Fes clic per seleccionar un vídeo</p>
								<p className="text-xs text-slate-500">MP4, MOV, WEBM</p>
							</div>
							{selectedFile && (
								<p className="mt-1 text-xs text-indigo-600">
									Seleccionat: <span className="font-medium">{selectedFile.name}</span>
								</p>
							)}
							<input id="file-video" type="file" accept="video/*" onChange={handleFileChange} className="hidden" />
						</label>

						<div className="space-y-3 text-xs text-slate-600">
							<div className="space-y-1">
								<div className="flex items-center justify-between">
									<span className="font-medium">Confiança mínima</span>
									<span className="font-semibold text-indigo-600">{(conf * 100).toFixed(0)}%</span>
								</div>
								<input type="range" min="0.1" max="0.9" step="0.05" value={conf} onChange={e => setConf(parseFloat(e.target.value))} className="w-full accent-indigo-500" />
							</div>

							<div className="space-y-1">
								<div className="flex items-center justify-between">
									<span className="font-medium">Stride</span>
									<span className="font-semibold text-indigo-600">{stride}</span>
								</div>
								<input type="range" min="1" max="10" step="1" value={stride} onChange={e => setStride(parseInt(e.target.value, 10))} className="w-full accent-indigo-500" />
							</div>
						</div>

						<button type="submit" disabled={loading || !selectedFile} className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-sm transition ${loading || !selectedFile ? "bg-slate-300 cursor-not-allowed" : "bg-indigo-500 hover:bg-indigo-600"}`}>
							{loading && <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
							{loading ? "Processant..." : "Generar vídeo anotat"}
						</button>

						{jobId && (
							<div className="space-y-2 rounded-2xl border border-slate-100 bg-white/80 px-4 py-3">
								<div className="flex items-center justify-between text-xs text-slate-600">
									<span className="font-medium">Estat: {jobState}</span>
									<span className="font-semibold">{Math.round(progress * 100)}%</span>
								</div>
								<div className="h-2 rounded-full bg-slate-200 overflow-hidden">
									<div className="h-full bg-indigo-500" style={{width: `${Math.round(progress * 100)}%`}} />
								</div>
								<p className="text-[11px] text-slate-500">{statusMsg}</p>
							</div>
						)}

						{error && (
							<div className="mt-2 rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 flex items-start gap-2">
								<span className="mt-0.5"></span>
								<div>
									<p className="font-semibold">Error</p>
									<p className="text-xs sm:text-sm">{error}</p>
								</div>
							</div>
						)}
					</form>

					<div className="space-y-3">
						<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
							<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">2</span>
							Original
						</h2>

						<div className="relative overflow-hidden rounded-2xl border border-slate-100 bg-slate-100/70 flex justify-center items-center w-full aspect-[16/9]">
							{!previewUrl && <div className="text-center text-slate-400 text-sm px-4">Encara no has seleccionat cap vídeo.</div>}
							{previewUrl && <video ref={videoRef} src={previewUrl} controls className="w-full h-full object-contain rounded-2xl" />}
						</div>
					</div>
				</section>

				<section className="space-y-5">
					<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
						<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">3</span>
						Resultat
					</h2>

					{result && (
						<div className="space-y-4 rounded-2xl border border-slate-100 bg-white/90 px-4 py-4 shadow-sm">
							<div className="text-sm text-slate-700 space-y-1">
								<p className="text-xs font-medium uppercase tracking-wide text-indigo-600">Resum</p>
								<p>
									Duració: <span className="font-semibold">{formatTime(totalDuration)}</span>
								</p>
								<p>
									Top global: <span className="font-semibold">{result.top_species_overall ?? "-"}</span>
								</p>
							</div>

							<div className="flex items-center gap-3 text-xs text-slate-600">
								<label>
									Velocitat{" "}
									<select value={playbackRate} onChange={e => setPlaybackRate(parseFloat(e.target.value))} className="ml-2 rounded-md border border-slate-200 bg-white px-2 py-1">
										<option value={0.5}>0.5×</option>
										<option value={1}>1×</option>
										<option value={1.25}>1.25×</option>
										<option value={1.5}>1.5×</option>
										<option value={2}>2×</option>
									</select>
								</label>
							</div>

							<div className="space-y-2">
								<p className="text-xs font-medium uppercase tracking-wide text-slate-400">Vídeo anotat</p>
								<div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-black/5 w-full aspect-[16/9]">{annotatedBlobUrl ? <video ref={annotatedVideoRef} src={annotatedBlobUrl} controls className="w-full h-full object-contain" /> : <div className="p-4 text-sm text-slate-500">Cargando vídeo anotado...</div>}</div>

								<div className="flex flex-wrap gap-2">
									{result?.video_url && (
										<button
											type="button"
											onClick={async () => {
												try {
													const url = absApiUrl(result.video_url);
													const res = await fetch(url, {headers: {Authorization: `Bearer ${token}`}});
													if (!res.ok) throw new Error("No se pudo descargar.");
													const blob = await res.blob();
													const blobUrl = URL.createObjectURL(blob);
													const a = document.createElement("a");
													a.href = blobUrl;
													a.download = "video_annotated.mp4";
													a.click();
													URL.revokeObjectURL(blobUrl);
												} catch (e) {
													setError(e.message);
												}
											}}
											className="px-4 py-2 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700">
											Descarregar MP4 anotat
										</button>
									)}

									{result?.video_id && (
										<button
											type="button"
											onClick={() => {
												setPublishedOk(false);
												setError("");
												setShowPublish(true);
												setPubTitle(pubTitle || `Vídeo ${new Date().toLocaleDateString()}`);
												setPubDesc(pubDesc || "");
											}}
											className="px-4 py-2 rounded-md bg-emerald-600 text-white text-xs hover:bg-emerald-700">
											Publicar
										</button>
									)}

									{publishedOk && <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-3 py-2">Publicat ✅</span>}
								</div>
							</div>
						</div>
					)}

					{!result && !loading && <p className="text-sm text-slate-500">Quan acabi el processament, aquí veuràs el vídeo anotat i podràs publicar-lo.</p>}
				</section>
			</div>

			<footer className="pt-2 border-t border-slate-100/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
				<span>Detector d'aus (vídeo) · TFG</span>
				<span>React + Tailwind</span>
			</footer>

			{/* Modal publicar */}
			{showPublish && (
				<div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
					<div className="w-full max-w-md rounded-3xl bg-white p-5 shadow-xl">
						<div className="flex items-center justify-between">
							<h3 className="font-bold text-slate-900">Publicar vídeo</h3>
							<button onClick={() => setShowPublish(false)} className="text-sm px-3 py-1 rounded-full bg-slate-100 hover:bg-slate-200">
								Tancar
							</button>
						</div>

						<div className="mt-4 space-y-3">
							<input className="w-full rounded-xl border px-3 py-2 text-sm" placeholder="Títol" value={pubTitle} onChange={e => setPubTitle(e.target.value)} />
							<textarea className="w-full rounded-xl border px-3 py-2 text-sm min-h-[90px]" placeholder="Descripció (opcional)" value={pubDesc} onChange={e => setPubDesc(e.target.value)} />

							{error && <p className="text-xs text-rose-600">{error}</p>}

							<button
								disabled={publishing}
								onClick={async () => {
									setPublishing(true);
									setError("");
									try {
										const res = await fetch(`${API_BASE}/posts`, {
											method: "POST",
											headers: {
												"Content-Type": "application/json",
												"Authorization": `Bearer ${token}`
											},
											body: JSON.stringify({
												video_id: result.video_id,
												title: pubTitle,
												description: pubDesc
											})
										});
										const data = await res.json().catch(() => ({}));
										if (!res.ok) throw new Error(data.detail || "Error publicant");

										setPublishedOk(true);
										setShowPublish(false);
									} catch (e) {
										setError(e.message);
									} finally {
										setPublishing(false);
									}
								}}
								className="w-full rounded-xl bg-emerald-600 text-white py-2 font-semibold disabled:opacity-50 hover:bg-emerald-700">
								{publishing ? "Publicant..." : "Publicar ara"}
							</button>
						</div>
					</div>
				</div>
			)}
		</main>
	);
}

export default VideoDetector;
