import {useEffect, useState} from "react";
import {useAuth} from "../auth/AuthContext";

function FeedPage() {
	const {token} = useAuth();
	const [items, setItems] = useState([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [offset, setOffset] = useState(0);

	const limit = 10;

	const load = async newOffset => {
		setLoading(true);
		setError("");
		try {
			const res = await fetch(`http://localhost:8000/posts/public?limit=${limit}&offset=${newOffset}`, {
				headers: {Authorization: `Bearer ${token}`}
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.detail || "Error cargando feed");
			if (newOffset === 0) setItems(data.items);
			else setItems(prev => [...prev, ...data.items]);
			setOffset(newOffset);
		} catch (e) {
			setError(e.message);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		if (!token) return;
		load(0);
	}, [token]);

	return (
		<main className="bg-white/80 backdrop-blur-xl border border-white/70 shadow-xl rounded-3xl p-6 sm:p-8 lg:p-10 flex flex-col gap-6 w-full mx-auto">
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="text-xl font-bold text-slate-900">Feed de vídeos publicats</h2>
				<button onClick={() => load(0)} className="text-xs px-3 py-2 rounded-full bg-white border border-slate-200 hover:bg-slate-50">
					Refrescar
				</button>
			</div>

			{error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-2xl px-4 py-3">⚠️ {error}</div>}

			{items.length === 0 && !loading && <p className="text-sm text-slate-600">Encara no hi ha publicacions.</p>}

			<div className="grid gap-6">
				{items.map(post => (
					<article key={post.id} className="rounded-3xl border border-slate-100 bg-white/90 shadow-sm overflow-hidden">
						<div className="p-4 sm:p-5">
							<div className="flex items-center justify-between gap-3">
								<div>
									<h3 className="font-bold text-slate-900">{post.title}</h3>
									<p className="text-xs text-slate-500">
										{post.author} · {new Date(post.created_at).toLocaleString()}
									</p>
								</div>
							</div>
							{post.description && <p className="mt-2 text-sm text-slate-700">{post.description}</p>}
						</div>

						<div className="bg-black/5">
							<video src={post.public_video_url} controls className="w-full h-auto" />
						</div>
					</article>
				))}
			</div>

			<div className="flex justify-center pt-2">
				<button disabled={loading} onClick={() => load(offset + limit)} className="px-5 py-2.5 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50 hover:bg-indigo-700">
					{loading ? "Carregant..." : "Carregar més"}
				</button>
			</div>
		</main>
	);
}

export default FeedPage;
