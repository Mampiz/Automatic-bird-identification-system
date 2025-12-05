import {useRef, useState} from "react";

function VideoDetector() {
	const [selectedFile, setSelectedFile] = useState(null);
	const [previewUrl, setPreviewUrl] = useState(null);
	const [result, setResult] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [conf, setConf] = useState(0.25); 
	const [stride, setStride] = useState(5);
	const [selectedSpecies, setSelectedSpecies] = useState("all"); 
	const videoRef = useRef(null);

	const API_URL_VIDEO = "http://localhost:8000/predict_video";

	const handleFileChange = e => {
		const file = e.target.files[0];
		setSelectedFile(file);
		setResult(null);
		setError("");
		setSelectedSpecies("all");

		if (file) {
			const url = URL.createObjectURL(file);
			setPreviewUrl(url);
		} else {
			setPreviewUrl(null);
		}
	};

	const formatTime = seconds => {
		if (seconds == null || isNaN(seconds)) return "-";
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	};

	const handleSubmit = async e => {
		e.preventDefault();
		if (!selectedFile) {
			setError("Selecciona primer un vídeo.");
			return;
		}

		setLoading(true);
		setError("");
		setResult(null);

		try {
			const formData = new FormData();
			formData.append("file", selectedFile);
			formData.append("conf", conf.toString());
			formData.append("stride", stride.toString());

			const res = await fetch(API_URL_VIDEO, {
				method: "POST",
				body: formData
			});

			if (!res.ok) {
				let errMsg = "Error en la predicció del vídeo";
				try {
					const errData = await res.json();
					errMsg = errData.error || errMsg;
				} catch {
					// ignore
				}
				throw new Error(errMsg);
			}

			const data = await res.json();
			setResult(data);
		} catch (err) {
			console.error(err);
			setError(err.message || "Error desconegut");
		} finally {
			setLoading(false);
		}
	};

	const totalDuration = result?.video_info && result.video_info.fps && result.video_info.frame_count ? result.video_info.frame_count / result.video_info.fps : null;

	const formatClasses = detections => {
		if (!detections || detections.length === 0) return "Cap au detectada";
		const uniqueClasses = Array.from(new Set(detections.map(d => d.class)));
		return uniqueClasses.join(", ");
	};

	const formatAvgConfidence = detections => {
		if (!detections || detections.length === 0) return "-";
		const avg = detections.reduce((acc, d) => acc + (d.confidence ?? 0), 0) / detections.length;
		return `${(avg * 100).toFixed(1)}%`;
	};

	const handleSeekToFrame = frame => {
		if (!videoRef.current || frame.time == null || isNaN(frame.time)) return;
		videoRef.current.currentTime = frame.time;
		videoRef.current.play();
	};

	const handleSeekToTime = time => {
		if (!videoRef.current || time == null || isNaN(time)) return;
		videoRef.current.currentTime = time;
		videoRef.current.play();
	};

	const handleDownloadImage = frame => {
		if (!frame.image_b64) return;
		const link = document.createElement("a");
		link.href = `data:image/jpeg;base64,${frame.image_b64}`;
		link.download = `frame_${frame.frame_index ?? "annotated"}.jpg`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const getSpeciesRanking = detectionsPerFrame => {
		if (!detectionsPerFrame) return [];
		const counter = {};

		detectionsPerFrame.forEach(frame => {
			frame.detections.forEach(det => {
				counter[det.class] = (counter[det.class] || 0) + 1;
			});
		});

		return Object.entries(counter)
			.sort((a, b) => b[1] - a[1])
			.map(([species, count]) => ({species, count}));
	};

	const handleDownloadJson = () => {
		if (!result) return;
		const blob = new Blob([JSON.stringify(result, null, 2)], {
			type: "application/json"
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "resultats_video.json";
		a.click();
	};

	const handleDownloadCsv = () => {
		if (!result?.detections_per_frame) return;

		const rows = ["frame_index,time,class,confidence"];

		result.detections_per_frame.forEach(f => {
			f.detections.forEach(det => {
				rows.push(`${f.frame_index},${f.time},${det.class},${det.confidence}`);
			});
		});

		const blob = new Blob([rows.join("\n")], {type: "text/csv"});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "deteccions_video.csv";
		a.click();
	};

	const speciesOptions = result?.detections_per_frame ? Array.from(new Set(result.detections_per_frame.flatMap(f => f.detections.map(d => d.class)))) : [];

	const filteredKeyFrames = !result?.key_frames ? [] : selectedSpecies === "all" ? result.key_frames : result.key_frames.filter(frame => frame.detections.some(d => d.class === selectedSpecies));

	return (
		<main className="bg-white/80 backdrop-blur-xl border border-white/70 shadow-xl rounded-3xl p-6 sm:p-8 lg:p-10 flex flex-col gap-8">
			<div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.8fr)] items-start">
				{/* Upload + paràmetres */}
				<section className="space-y-4">
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
								<p className="text-xs text-slate-500">MP4, MOV, WEBM · idealment amb les aus visibles a càmera</p>
							</div>
							{selectedFile && (
								<p className="mt-1 text-xs text-indigo-600">
									Seleccionat: <span className="font-medium">{selectedFile.name}</span>
								</p>
							)}
							<input id="file-video" type="file" accept="video/*" onChange={handleFileChange} className="hidden" />
						</label>

						{/* Controls de conf i stride */}
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
									<span className="font-medium">Mida de pas (stride)</span>
									<span className="font-semibold text-indigo-600">{stride} fotogrames</span>
								</div>
								<input type="range" min="1" max="10" step="1" value={stride} onChange={e => setStride(parseInt(e.target.value, 10))} className="w-full accent-indigo-500" />
								<p className="text-[11px] text-slate-500">Valors més baixos = més precís però més lent; valors més alts = més ràpid però amb menys fotogrames analitzats.</p>
							</div>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button type="submit" disabled={loading || !selectedFile} className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-sm transition ${loading || !selectedFile ? "bg-slate-300 cursor-not-allowed" : "bg-indigo-500 hover:bg-indigo-600"}`}>
								{loading && <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
								{loading ? "Analitzant vídeo..." : "Detectar aus en el vídeo"}
							</button>

							<span className="text-xs text-slate-500">
								El processament es fa a<span className="hidden sm:inline"> (http://localhost:8000/predict_video).</span>
							</span>
						</div>

						{error && (
							<div className="mt-2 rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 flex items-start gap-2">
								<span className="mt-0.5">⚠️</span>
								<div>
									<p className="font-semibold">Error</p>
									<p className="text-xs sm:text-sm">{error}</p>
								</div>
							</div>
						)}
					</form>

					{/* Vista prèvia del vídeo */}
					<div className="space-y-3">
						<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
							<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">2</span>
							Vista prèvia del vídeo
						</h2>

						<div className="relative overflow-hidden rounded-2xl border border-slate-100 bg-slate-100/70 flex justify-center items-center aspect-[16/9]">
							{!previewUrl && <div className="text-center text-slate-400 text-sm px-4">Encara no has seleccionat cap vídeo. Quan ho facis, apareixerà aquí.</div>}

							{previewUrl && <video ref={videoRef} src={previewUrl} controls className="w-full h-full object-contain rounded-2xl" />}
						</div>
					</div>
				</section>

				{/* Resultats */}
				<section className="space-y-5">
					<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
						<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">3</span>
						Resultat de l'anàlisi del vídeo
					</h2>

					{!result && !loading && <p className="text-sm text-slate-500">Quan enviïs un vídeo, aquí es mostraran els trams on s'han detectat aus i els fotogrames més representatius.</p>}

					{loading && (
						<div className="rounded-2xl border border-slate-100 bg-white/80 px-4 py-4 flex items-center gap-3 text-sm text-slate-600">
							<span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-500" />
							Analitzant el vídeo fotograma a fotograma i detectant aus...
						</div>
					)}

					{result && (
						<div className="space-y-5 rounded-2xl border border-slate-100 bg-white/90 px-4 py-4 shadow-sm min-h-[26rem]">
							{/* Resum vídeo */}
							<div className="space-y-1 text-sm text-slate-700">
								<p className="text-xs font-medium uppercase tracking-wide text-indigo-600">Resum del vídeo</p>
								<p>
									FPS: <span className="font-semibold">{result.video_info?.fps?.toFixed ? result.video_info.fps.toFixed(2) : result.video_info?.fps}</span>
								</p>
								<p>
									Fotogrames totals: <span className="font-semibold">{result.video_info?.frame_count}</span>
								</p>
								<p>
									Resolució:{" "}
									<span className="font-semibold">
										{result.video_info?.width} × {result.video_info?.height}
									</span>
								</p>
								<p>
									Duració aprox.: <span className="font-semibold">{formatTime(totalDuration)}</span>
								</p>
								<p>
									Fotogrames amb deteccions (mostrejats): <span className="font-semibold">{result.num_frames_with_detections}</span>
								</p>
							</div>

							{/* Línia temporal de deteccions */}
							{totalDuration && result.segments && result.segments.length > 0 && (
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-slate-400">Línia temporal de deteccions</p>
									<div className="relative h-2 rounded-full bg-slate-200 overflow-hidden">
										{result.segments.map((seg, idx) => {
											const startRatio = seg.start_time && totalDuration ? seg.start_time / totalDuration : 0;
											const endRatio = seg.end_time && totalDuration ? seg.end_time / totalDuration : startRatio;
											const widthRatio = Math.max(endRatio - startRatio, 0.01);

											return (
												<button
													type="button"
													key={idx}
													className="absolute top-0 h-full bg-indigo-400/80 hover:bg-indigo-500 transition"
													style={{
														left: `${startRatio * 100}%`,
														width: `${widthRatio * 100}%`
													}}
													onClick={() => handleSeekToTime(seg.start_time)}
												/>
											);
										})}
									</div>
									<div className="flex justify-between text-[10px] text-slate-400">
										<span>0:00</span>
										<span>{formatTime(totalDuration)}</span>
									</div>
								</div>
							)}

							{/* Ranking d'espècies */}
							<div className="space-y-1 text-xs sm:text-sm text-slate-700">
								<p className="text-xs font-medium uppercase tracking-wide text-indigo-600">Espècies més detectades</p>
								{getSpeciesRanking(result.detections_per_frame).length === 0 ? (
									<p className="text-sm text-slate-500">Encara no hi ha dades suficients.</p>
								) : (
									<ul className="space-y-1">
										{getSpeciesRanking(result.detections_per_frame).map((item, idx) => (
											<li key={idx} className="flex justify-between">
												<span>
													{idx + 1}. {item.species}
												</span>
												<span className="font-semibold">{item.count} deteccions</span>
											</li>
										))}
									</ul>
								)}
							</div>

							{/* Botons d'exportació */}
							<div className="flex flex-wrap gap-3 pt-2">
								<button onClick={handleDownloadJson} className="px-4 py-2 rounded-md bg-slate-800 text-white text-xs hover:bg-slate-900">
									Descarregar JSON
								</button>
								<button onClick={handleDownloadCsv} className="px-4 py-2 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700">
									Descarregar CSV
								</button>
							</div>

							<div className="grid gap-4 lg:grid-cols-2 lg:items-start pt-2">
								{/* Trams amb aus detectades */}
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-slate-400">Trams amb aus detectades</p>

									{(!result.segments || result.segments.length === 0) && <p className="text-sm text-slate-500">No s'han trobat trams amb aus per sobre del llindar de confiança.</p>}

									{result.segments && result.segments.length > 0 && (
										<ul className="space-y-1 max-h-[22rem] overflow-auto pr-1 text-xs sm:text-sm text-slate-700">
											{result.segments.map((seg, idx) => (
												<li key={idx} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
													<div className="flex items-center gap-2">
														<span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">{idx + 1}</span>
														<div className="flex flex-col">
															<span>
																De <span className="font-semibold">{formatTime(seg.start_time)}</span> a <span className="font-semibold">{formatTime(seg.end_time)}</span>
															</span>
															<span className="text-[11px] text-slate-500">
																Fotogrames {seg.start_frame}–{seg.end_frame}
															</span>
														</div>
													</div>
												</li>
											))}
										</ul>
									)}
								</div>

								{/* Fotogrames representatius amb filtre per espècie */}
								<div className="space-y-2">
									<p className="text-xs font-medium uppercase tracking-wide text-slate-400">Fotogrames representatius amb aus detectades</p>

									{/* Filtre per espècie */}
									{speciesOptions.length > 0 && (
										<div className="space-y-1 text-xs text-slate-600">
											<label className="font-medium">Filtrar fotogrames per espècie</label>
											<select value={selectedSpecies} onChange={e => setSelectedSpecies(e.target.value)} className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
												<option value="all">Totes les espècies</option>
												{speciesOptions.map(sp => (
													<option key={sp} value={sp}>
														{sp}
													</option>
												))}
											</select>
										</div>
									)}

									{(!result.key_frames || result.key_frames.length === 0) && <p className="text-sm text-slate-500">No hi ha fotogrames representatius disponibles.</p>}

									{filteredKeyFrames.length > 0 && (
										<ul className="space-y-3 max-h-[22rem] overflow-auto pr-1 text-xs sm:text-sm text-slate-700">
											{filteredKeyFrames.map((frame, idx) => (
												<li key={frame.frame_index ?? idx} className="rounded-2xl border border-slate-100 bg-slate-50 px-3 py-3 flex flex-col gap-2">
													<div className="flex items-center justify-between gap-3">
														<div className="flex items-center gap-2">
															<span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-semibold text-indigo-700">{idx + 1}</span>
															<div className="flex flex-col">
																<span className="font-medium">
																	Fotograma {frame.frame_index} · t=
																	{formatTime(frame.time)}
																</span>
																<span className="text-[11px] text-slate-500">
																	Confiança mitjana: <span className="font-semibold">{formatAvgConfidence(frame.detections)}</span>
																</span>
															</div>
														</div>
													</div>

													<p className="text-[11px] text-slate-500">
														Aus detectades: <span className="font-semibold">{formatClasses(frame.detections)}</span>
													</p>

													{frame.image_b64 && (
														<div className="mt-1">
															<img src={`data:image/jpeg;base64,${frame.image_b64}`} alt={`Fotograma ${frame.frame_index} amb aus detectades`} className="w-full max-h-64 object-contain rounded-xl border border-slate-200" />
														</div>
													)}

													<div className="mt-2 flex flex-wrap gap-2">
														<button type="button" onClick={() => handleSeekToFrame(frame)} className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[11px] font-medium text-white bg-indigo-500 hover:bg-indigo-600 transition">
															Anar a aquest moment
														</button>
														{frame.image_b64 && (
															<button type="button" onClick={() => handleDownloadImage(frame)} className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[11px] font-medium text-indigo-600 bg-white border border-indigo-100 hover:bg-indigo-50 transition">
																Descarregar imatge
															</button>
														)}
													</div>
												</li>
											))}
										</ul>
									)}
								</div>
							</div>
						</div>
					)}
				</section>
			</div>

			<footer className="pt-2 border-t border-slate-100/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
				<span>Detector d'aus (vídeo) · TFG</span>
				<span>
					Frontend fet amb <span className="text-indigo-500">React + Tailwind</span>
				</span>
			</footer>
		</main>
	);
}

export default VideoDetector;
