import {useState} from "react";
import {BrowserRouter, Link, Route, Routes, useLocation} from "react-router-dom";
import {useAuth} from "./auth/AuthContext";
import AuthGate from "./components/AuthGate";
import FeedPage from "./components/FeedPage";
import ImageDetector from "./components/ImageDetector";
import StreamDetector from "./components/StreamDetector";
import UserBadge from "./components/UserBadge";
import VideoDetector from "./components/VideoDetector";

function Home({tab}) {
	return <AuthGate>{tab === "image" ? <ImageDetector /> : <VideoDetector />}</AuthGate>;
}

function AppShell() {
	const location = useLocation();
	const [tab, setTab] = useState("image");
	const {token, booting} = useAuth();

	const isStreamPage = location.pathname === "/stream";
	const hideNav = !token && !booting;

	return (
		<div className="min-h-screen bg-[url('https://images.unsplash.com/photo-1502252430442-aac78f397426?fm=jpg&q=60&w=3000&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Nnx8NGslMjBmb3Jlc3R8ZW58MHx8MHx8fDA%3D')] bg-cover bg-center text-slate-800">
			<div className="relative">
				<div className={isStreamPage ? "w-full px-0 py-0" : "max-w-5xl mx-auto px-4 py-10 lg:py-16"}>
					<header className={isStreamPage ? "flex flex-col items-center gap-3 px-4 pt-6 pb-4" : "flex flex-col items-center gap-4 mb-8"}>
						<div className="w-full flex justify-end">
							<UserBadge />
						</div>

						<div className="text-center">
							<h1 className="text-4xl sm:text-5xl lg:text-7xl font-extrabold tracking-tight">
								<span className="text-emerald-400">Detector</span> <span className="text-white">d’aus</span>
							</h1>
							<p className="mt-2 text-sm text-emerald-200/80">Sistema d'identificació d’espècies</p>
						</div>

						{!hideNav && (
							<div className="flex items-center gap-2 flex-wrap justify-center">
								<Link to="/" className={`px-4 py-2 rounded-full text-xs sm:text-sm bg-white/90 border border-white/60 text-slate-800 hover:bg-white ${location.pathname === "/" ? "font-bold" : ""}`}>
									Detector
								</Link>

								<Link to="/feed" className={`px-4 py-2 rounded-full text-xs sm:text-sm bg-white/90 border border-white/60 text-slate-800 hover:bg-white ${location.pathname === "/feed" ? "font-bold" : ""}`}>
									Feed
								</Link>

								<Link to="/stream" className={`px-4 py-2 rounded-full text-xs sm:text-sm bg-white/90 border border-white/60 text-slate-800 hover:bg-white ${location.pathname === "/stream" ? "font-bold" : ""}`}>
									Directe
								</Link>
							</div>
						)}

						{!hideNav && location.pathname === "/" && (
							<div className="mt-2 inline-flex rounded-full bg-white/90 p-1 shadow-sm border border-white/60">
								<button onClick={() => setTab("image")} className={`px-4 sm:px-6 py-1.5 text-xs sm:text-sm rounded-full transition ${tab === "image" ? "bg-emerald-500 text-white shadow" : "text-slate-700 hover:bg-slate-100"}`}>
									Imatges
								</button>
								<button onClick={() => setTab("video")} className={`px-4 sm:px-6 py-1.5 text-xs sm:text-sm rounded-full transition ${tab === "video" ? "bg-indigo-500 text-white shadow" : "text-slate-700 hover:bg-slate-100"}`}>
									Videos
								</button>
							</div>
						)}
					</header>

					<Routes>
						<Route path="/" element={<Home tab={tab} />} />
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
