import {useState} from "react";
import {BrowserRouter, Link, Route, Routes, useLocation} from "react-router-dom";
import AuthGate from "./components/AuthGate";
import FeedPage from "./components/FeedPage";
import ImageDetector from "./components/ImageDetector";
import StreamDetector from "./components/StreamDetector";
import {LayoutTextFlip} from "./components/ui/layout-text-flip";
import UserBadge from "./components/UserBadge";
import VideoDetector from "./components/VideoDetector";

function Home({tab, setTab}) {
	return <AuthGate>{tab === "image" ? <ImageDetector /> : <VideoDetector />}</AuthGate>;
}

function AppShell() {
	const location = useLocation();
	const [tab, setTab] = useState("image");

	const isStreamPage = location.pathname === "/stream";

	return (
		<div className="min-h-screen bg-[url('https://images.unsplash.com/photo-1502252430442-aac78f397426?fm=jpg&q=60&w=3000&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Nnx8NGslMjBmb3Jlc3R8ZW58MHx8MHx8fDA%3D')] bg-cover bg-center text-slate-800">
			{/* Wrapper: normal pages centered / stream full width */}
			<div className={isStreamPage ? "w-full px-0 py-0" : "max-w-5xl mx-auto px-4 py-10 lg:py-16"}>
				{/* Header: for stream keep it smaller */}
				<header className={isStreamPage ? "relative flex flex-col items-center gap-3 px-4 pt-6 pb-4" : "relative flex flex-col items-center gap-4 mb-8"}>
					<div className={isStreamPage ? "w-full flex justify-end" : "w-full flex justify-end"}>
						<UserBadge />
					</div>

					<h1 className="text-3xl sm:text-4xl lg:text-6xl font-bold text-green-500 text-center tracking-tight">
						Detector d'aus <span className="inline-block align-middle pb-5">🐦</span>
					</h1>


					<div className="flex items-center gap-2 flex-wrap justify-center">
						<Link to="/" className={`px-4 py-2 rounded-full text-xs sm:text-sm bg-white/80 border border-white/60 hover:bg-white ${location.pathname === "/" ? "font-bold" : ""}`}>
							Detector
						</Link>

						<Link to="/feed" className={`px-4 py-2 rounded-full text-xs sm:text-sm bg-white/80 border border-white/60 hover:bg-white ${location.pathname === "/feed" ? "font-bold" : ""}`}>
							Feed
						</Link>

						<Link to="/stream" className={`px-4 py-2 rounded-full text-xs sm:text-sm bg-white/80 border border-white/60 hover:bg-white ${location.pathname === "/stream" ? "font-bold" : ""}`}>
							Directe
						</Link>
					</div>

					{location.pathname === "/" && (
						<div className="mt-2 inline-flex rounded-full bg-white/80 p-1 shadow-sm border border-white/60">
							<button onClick={() => setTab("image")} className={`px-4 sm:px-6 py-1.5 text-xs sm:text-sm rounded-full transition ${tab === "image" ? "bg-emerald-500 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}>
								Imatges
							</button>
							<button onClick={() => setTab("video")} className={`px-4 sm:px-6 py-1.5 text-xs sm:text-sm rounded-full transition ${tab === "video" ? "bg-indigo-500 text-white shadow" : "text-slate-600 hover:bg-slate-100"}`}>
								Videos
							</button>
						</div>
					)}
				</header>

				<Routes>
					<Route path="/" element={<Home tab={tab} setTab={setTab} />} />

					<Route
						path="/feed"
						element={
							<AuthGate>
								<FeedPage />
							</AuthGate>
						}
					/>

					<Route
						path="/stream"
						element={
							<AuthGate>
								<StreamDetector />
							</AuthGate>
						}
					/>
				</Routes>

				{!isStreamPage && <div className="h-10" />}
			</div>
		</div>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppShell />
		</BrowserRouter>
	);
}
