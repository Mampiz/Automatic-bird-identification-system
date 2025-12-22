import {useMemo, useState} from "react";
import {useAuth} from "../auth/AuthContext";

function EyeIcon({open}) {
	return <span className="select-none">{open ? "🙈" : "👁️"}</span>;
}

export default function AuthGate({children}) {
	const {token, booting, login, register} = useAuth();

	const [mode, setMode] = useState("login"); // "login" | "register"
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [okMsg, setOkMsg] = useState("");

	const title = useMemo(() => (mode === "login" ? "Inicia sessió" : "Crea el teu compte"), [mode]);

	const onSubmit = async e => {
		e.preventDefault();
		setError("");
		setOkMsg("");

		if (!email.trim()) return setError("Escriu un email.");
		if (!password) return setError("Escriu una contrasenya.");
		if (password.length < 6) return setError("La contrasenya ha de tenir mínim 6 caràcters.");

		setLoading(true);
		try {
			if (mode === "register") {
				await register({email: email.trim(), password});
				setOkMsg("Compte creat ✅ Ara inicia sessió.");
				setMode("login");
				setPassword("");
			} else {
				await login({email: email.trim(), password});
			}
		} catch (err) {
			setError(err.message || "Error desconegut");
		} finally {
			setLoading(false);
		}
	};

	if (booting) {
		return (
			<div className="bg-white/80 backdrop-blur-xl border border-white/70 shadow-xl rounded-3xl p-8 w-full mx-auto">
				<p className="text-sm text-slate-600">Carregant…</p>
			</div>
		);
	}

	if (token) return children;

	return (
		<div className="bg-white/80 backdrop-blur-xl border border-white/70 shadow-xl rounded-3xl p-6 sm:p-8 lg:p-10 w-full mx-auto">
			<div className="max-w-md mx-auto">
				<div className="text-center mb-6">
					<h2 className="text-2xl font-bold text-slate-900">{title}</h2>
					<p className="text-sm text-slate-600 mt-1">{mode === "login" ? "Accedeix per analitzar i publicar." : "Registra’t per començar."}</p>
				</div>

				<div className="inline-flex w-full rounded-2xl bg-white/70 border border-white/60 shadow-sm p-1 mb-6">
					<button
						type="button"
						onClick={() => {
							setMode("login");
							setError("");
							setOkMsg("");
						}}
						className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition ${mode === "login" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
						Iniciar sessió
					</button>
					<button
						type="button"
						onClick={() => {
							setMode("register");
							setError("");
							setOkMsg("");
						}}
						className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition ${mode === "register" ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
						Registrar-se
					</button>
				</div>

				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-1">
						<label className="text-xs font-semibold text-slate-700">Email</label>
						<input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="tuemail@gmail.com" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
					</div>

					<div className="space-y-1">
						<label className="text-xs font-semibold text-slate-700">Contrasenya</label>
						<div className="flex items-stretch gap-2">
							<input value={password} onChange={e => setPassword(e.target.value)} type={showPassword ? "text" : "password"} placeholder={mode === "register" ? "mínim 6 caràcters" : "la teva contrasenya"} className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
							<button type="button" onClick={() => setShowPassword(v => !v)} className="shrink-0 rounded-2xl border border-slate-200 bg-white px-4 text-sm hover:bg-slate-50" aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
								<EyeIcon open={showPassword} />
							</button>
						</div>
						<p className="text-[11px] text-slate-500">Prem l’ull per mostrar/ocultar.</p>
					</div>

					{error && (
						<div className="rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
							<span className="font-semibold">Error</span>
							<div className="text-xs mt-1">{error}</div>
						</div>
					)}

					{okMsg && (
						<div className="rounded-2xl border border-emerald-100 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-800">
							<span className="font-semibold">OK</span>
							<div className="text-xs mt-1">{okMsg}</div>
						</div>
					)}

					<button disabled={loading} type="submit" className={`w-full rounded-2xl py-3 text-sm font-bold text-white transition shadow-sm ${loading ? "bg-slate-400 cursor-not-allowed" : mode === "login" ? "bg-indigo-600 hover:bg-indigo-700" : "bg-emerald-600 hover:bg-emerald-700"}`}>
						{loading ? "Processant..." : mode === "login" ? "Entrar" : "Crear compte"}
					</button>
				</form>

				<p className="text-[11px] text-slate-500 mt-5 text-center">TFG · Detector d’aus · Accés protegit</p>
			</div>
		</div>
	);
}
