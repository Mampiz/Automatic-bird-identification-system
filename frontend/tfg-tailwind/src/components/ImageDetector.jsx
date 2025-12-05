import {useState} from "react";

function ImageDetector() {
	const [selectedFile, setSelectedFile] = useState(null);
	const [previewUrl, setPreviewUrl] = useState(null);
	const [result, setResult] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [imgLoaded, setImgLoaded] = useState(false);
	const [conf, setConf] = useState(0.25); // confiança mínima
	const [selectedSpecies, setSelectedSpecies] = useState("all"); // filtre d'espècie

	const API_URL = "http://localhost:8000/predict";

	const handleFileChange = e => {
		const file = e.target.files[0];
		setSelectedFile(file);
		setResult(null);
		setError("");
		setImgLoaded(false);
		setSelectedSpecies("all");

		if (file) {
			const url = URL.createObjectURL(file);
			setPreviewUrl(url);
		} else {
			setPreviewUrl(null);
		}
	};

	const handleSubmit = async e => {
		e.preventDefault();
		if (!selectedFile) {
			setError("Selecciona primer una imatge.");
			return;
		}

		setLoading(true);
		setError("");
		setResult(null);

		try {
			const formData = new FormData();
			formData.append("file", selectedFile);
			formData.append("conf", conf.toString());

			const res = await fetch(API_URL, {
				method: "POST",
				body: formData
			});

			if (!res.ok) {
				let errMsg = "Error en la predicció";
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

	// Confiança mitjana de totes les deteccions
	const formatAvgConfidence = detections => {
		if (!detections || detections.length === 0) return "-";
		const avg = detections.reduce((acc, d) => acc + (d.confidence ?? 0), 0) / detections.length;
		return `${(avg * 100).toFixed(1)}%`;
	};

	// Llista d’espècies sense duplicats
	const getSpeciesList = detections => {
		if (!detections || detections.length === 0) return [];
		return Array.from(new Set(detections.map(d => d.class)));
	};

	const formatClasses = detections => {
		const list = getSpeciesList(detections);
		if (list.length === 0) return "Cap au detectada";
		return list.join(", ");
	};

	// Descarregar una imatge amb les caixes dibuixades (es genera al client)
	const handleDownloadAnnotated = () => {
		if (!previewUrl || !result?.detections || result.detections.length === 0) return;

		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			const ctx = canvas.getContext("2d");

			ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

			result.detections.forEach(det => {
				const [x1_n, y1_n, x2_n, y2_n] = det.bbox_norm;
				const x1 = x1_n * canvas.width;
				const y1 = y1_n * canvas.height;
				const x2 = x2_n * canvas.width;
				const y2 = y2_n * canvas.height;

				ctx.strokeStyle = "#10b981";
				ctx.lineWidth = Math.max(2, canvas.width * 0.002);
				ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

				const label = `${det.class} ${(det.confidence * 100).toFixed(1)}%`;
				ctx.font = `${Math.max(12, canvas.width * 0.015)}px sans-serif`;
				const textWidth = ctx.measureText(label).width;
				const padding = 4;
				const boxHeight = parseInt(ctx.font, 10) + padding * 2;

				ctx.fillStyle = "rgba(16, 185, 129, 0.9)";
				ctx.fillRect(x1, Math.max(0, y1 - boxHeight), textWidth + padding * 2, boxHeight);

				ctx.fillStyle = "#ffffff";
				ctx.fillText(label, x1 + padding, Math.max(0, y1 - boxHeight / 2));
			});

			const link = document.createElement("a");
			link.href = canvas.toDataURL("image/jpeg");
			link.download = "image_annotated.jpg";
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
		};
		img.src = previewUrl;
	};

	const filteredDetections = selectedSpecies === "all" || !result?.detections ? result?.detections ?? [] : result.detections.filter(det => det.class === selectedSpecies);

	const speciesOptions = result ? getSpeciesList(result.detections) : [];

	return (
		<main className="bg-white/80 backdrop-blur-xl border border-white/70 shadow-xl rounded-3xl p-6 sm:p-8 lg:p-10 flex flex-col gap-8">
			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-start">
				{/* Zona d'upload */}
				<section className="space-y-4">
					<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
						<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">1</span>
						Puja la teva imatge
					</h2>

					<form onSubmit={handleSubmit} className="space-y-4">
						<label htmlFor="file-image" className="flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center cursor-pointer transition hover:border-emerald-300 hover:bg-emerald-50/60">
							<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm">
								<span className="text-2xl">📷</span>
							</div>
							<div className="space-y-1">
								<p className="text-sm font-medium text-slate-900">Fes clic per seleccionar una imatge</p>
								<p className="text-xs text-slate-500">JPG, PNG o WEBP · idealment amb les aus visibles</p>
							</div>
							{selectedFile && (
								<p className="mt-1 text-xs text-emerald-600">
									Seleccionat: <span className="font-medium">{selectedFile.name}</span>
								</p>
							)}
							<input id="file-image" type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
						</label>

						{/* Control de confiança */}
						<div className="space-y-2 text-xs text-slate-600">
							<div className="flex items-center justify-between">
								<span className="font-medium">Confiança mínima</span>
								<span className="font-semibold text-emerald-600">{(conf * 100).toFixed(0)}%</span>
							</div>
							<input type="range" min="0.1" max="0.9" step="0.05" value={conf} onChange={e => setConf(parseFloat(e.target.value))} className="w-full accent-emerald-500" />
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button type="submit" disabled={loading || !selectedFile} className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-sm transition ${loading || !selectedFile ? "bg-slate-300 cursor-not-allowed" : "bg-emerald-500 hover:bg-emerald-600"}`}>
								{loading && <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
								{loading ? "Detectant aus..." : "Detectar aus"}
							</button>

							<span className="text-xs text-slate-500">
								El processament es fa a<span className="hidden sm:inline"> (http://localhost:8000).</span>
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
				</section>

				{/* Vista prèvia + resultats */}
				<section className="space-y-5">
					{/* Vista prèvia amb deteccions */}
					<div className="space-y-3">
						<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
							<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">2</span>
							Vista prèvia amb deteccions
						</h2>

						<div className={`relative overflow-hidden rounded-2xl border border-slate-100 bg-slate-100/70 flex justify-center items-center ${!previewUrl || !imgLoaded ? "aspect-[4/3]" : ""}`}>
							{!previewUrl && <div className="text-center text-slate-400 text-sm px-4">Encara no heu seleccionat cap imatge. Quan ho facis, la veuràs aquí.</div>}

							{previewUrl && (
								<img
									src={previewUrl}
									alt="preview"
									className={`max-w-full h-auto object-contain transition-opacity duration-300 ${imgLoaded ? "opacity-100" : "opacity-0"}`}
									onLoad={() => {
										setImgLoaded(true);
									}}
								/>
							)}

							{imgLoaded && result?.detections && (
								<div className="absolute inset-0 pointer-events-none">
									{result.detections.map((det, idx) => {
										const [x1, y1, x2, y2] = det.bbox_norm;
										const dimmed = selectedSpecies !== "all" && det.class !== selectedSpecies;

										return (
											<div
												key={idx}
												className={`absolute rounded-md shadow-[0_0_0_1px_rgba(16,185,129,0.4)] transition ${dimmed ? "border border-emerald-200/40 opacity-40" : "border-2 border-emerald-400 opacity-100"}`}
												style={{
													left: `${x1 * 100}%`,
													top: `${y1 * 100}%`,
													width: `${(x2 - x1) * 100}%`,
													height: `${(y2 - y1) * 100}%`
												}}>
												<span className={`absolute -top-5 left-0 text-[10px] px-1.5 py-0.5 rounded shadow ${dimmed ? "bg-emerald-400/70 text-white/80" : "bg-emerald-500 text-white"}`}>
													{det.class} ({(det.confidence * 100).toFixed(1)}%)
												</span>
											</div>
										);
									})}
								</div>
							)}
						</div>
					</div>

					{/* Resultats del model */}
					<div className="space-y-3">
						<h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
							<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold">3</span>
							Resultat del model
						</h2>

						{!result && !loading && <p className="text-sm text-slate-500">Quan envieu una imatge, veureu aquí la llista d'aus detectades (espècie i confiança).</p>}

						{loading && (
							<div className="rounded-2xl border border-slate-100 bg-white/80 px-4 py-4 flex items-center gap-3 text-sm text-slate-600">
								<span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-500" />
								Analitzant la imatge i buscant aus...
							</div>
						)}

						{result && (
							<div className="space-y-4 rounded-2xl border border-slate-100 bg-white/90 px-4 py-4 shadow-sm min-h-[18rem]">
								<div className="flex items-start justify-between gap-3">
									<div className="space-y-1">
										<p className="text-xs font-medium uppercase tracking-wide text-emerald-600">Resum</p>
										<p className="text-sm text-slate-700">
											S'han detectat <span className="font-semibold">{result.num_detections ?? result.detections.length}</span> aus a la imatge.
										</p>
										<p className="text-xs text-slate-500">
											Confiança mitjana: <span className="font-semibold">{formatAvgConfidence(result.detections)}</span>
										</p>
										<p className="text-xs text-slate-500">
											Espècies detectades: <span className="font-semibold">{formatClasses(result.detections)}</span>
										</p>
									</div>

									{result.detections.length > 0 && (
										<button type="button" onClick={handleDownloadAnnotated} className="inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 hover:bg-emerald-100 transition">
											Descarregar imatge anotada
										</button>
									)}
								</div>

								{/* Filtre per espècie */}
								{speciesOptions.length > 0 && (
									<div className="space-y-1 text-xs text-slate-600">
										<label className="font-medium">Filtrar deteccions per espècie</label>
										<select value={selectedSpecies} onChange={e => setSelectedSpecies(e.target.value)} className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500">
											<option value="all">Totes les espècies</option>
											{speciesOptions.map(sp => (
												<option key={sp} value={sp}>
													{sp}
												</option>
											))}
										</select>
									</div>
								)}

								{result.detections.length === 0 ? (
									<p className="text-sm text-slate-500">No s'ha detectat cap au amb la confiança mínima configurada.</p>
								) : (
									<div className="space-y-2">
										<p className="text-xs font-medium uppercase tracking-wide text-slate-400">Deteccions</p>
										<ul className="space-y-1 max-h-60 overflow-auto pr-1">
											{filteredDetections.map((det, idx) => (
												<li key={idx} className="flex items-center justify-between text-xs sm:text-sm text-slate-700">
													<span className="flex items-center gap-2">
														<span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-500">{idx + 1}</span>
														{det.class}
													</span>
													<span className="font-medium text-slate-900">{(det.confidence * 100).toFixed(1)}%</span>
												</li>
											))}
										</ul>
									</div>
								)}
							</div>
						)}
					</div>
				</section>
			</div>

			<footer className="pt-2 border-t border-slate-100/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
				<span>Detector d'aus (imatges) · TFG</span>
				<span>
					Frontend fet amb <span className="text-emerald-500">React + Tailwind</span>
				</span>
			</footer>
		</main>
	);
}

export default ImageDetector;
