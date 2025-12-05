import {useState} from "react";
import ImageDetector from "./components/ImageDetector";
import VideoDetector from "./components/VideoDetector";
import {LayoutTextFlip} from "./components/ui/layout-text-flip";

function App() {
	const [tab, setTab] = useState("image");

	return (
		<div className="min-h-screen bg-[url('https://images.unsplash.com/photo-1502252430442-aac78f397426?fm=jpg&q=60&w=3000&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Nnx8NGslMjBmb3Jlc3R8ZW58MHx8MHx8fDA%3D')] bg-cover bg-center text-slate-800">
			<div className="max-w-5xl mx-auto px-4 py-10 lg:py-16">
				{/* Header */}
				<header className="flex flex-col items-center gap-4 mb-8">
					<h1 className="text-3xl sm:text-4xl lg:text-6xl font-bold text-green-500 text-center tracking-tight">
						Detector d'aus <span className="inline-block align-middle pb-5">🐦</span>
					</h1>
					<LayoutTextFlip text="Quina serà l'au que estàs buscant? Serà un/una..." words={["Abellerol comú", "Cames llargues", "Estornell negre", "Merla blava", "Pardal xarrec", "Picot verd ibèric", "Xatrac bec-llarg", "Cadernera europea", "Roquerol", "Tallarol de casquet", "Mallerenga petita", "Gavina capnegra americana"]} className="mt-3 text-3xl sm:text-4xl lg:text-3xl font-bold text-indigo-600 text-center tracking-tight" />
					<p className="text-green-500 font-bold text-center max-w-xl">Josep Mampel Marques · TFG</p>

					{/* Tabs */}
					<div className="mt-2 inline-flex rounded-full bg-white/80 p-1 shadow-sm border border-white/60">
						<button onClick={() => setTab("image")} className={`px-4 sm:px-6 py-1.5 text-xs sm:text-sm rounded-full transition ${tab === "image" ? "bg-emerald-500 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}>
							Imatges
						</button>
						<button onClick={() => setTab("video")} className={`px-4 sm:px-6 py-1.5 text-xs sm:text-sm rounded-full transition ${tab === "video" ? "bg-indigo-500 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}>
							Videos
						</button>
					</div>
				</header>

				{tab === "image" ? <ImageDetector /> : <VideoDetector />}
			</div>
		</div>
	);
}

export default App;
