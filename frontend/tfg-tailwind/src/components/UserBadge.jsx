import {useAuth} from "../auth/AuthContext";

export default function UserBadge() {
	const {userEmail, token, logout} = useAuth();

	if (!token) return null;

	return (
		<div className="flex items-center gap-2 rounded-full bg-white/80 border border-white/60 shadow-sm px-3 py-2">
			<span className="text-xs sm:text-sm font-semibold text-slate-700 truncate max-w-[170px] sm:max-w-[260px]">{userEmail || "Usuari"}</span>
			<button onClick={logout} className="text-xs sm:text-sm font-semibold rounded-full bg-slate-900 text-white px-3 py-1.5 hover:bg-slate-800 transition">
				Tancar sessió
			</button>
		</div>
	);
}
