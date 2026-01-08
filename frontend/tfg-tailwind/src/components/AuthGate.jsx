import {useMemo, useState} from "react";
import {useAuth} from "../auth/AuthContext";

function EyeIcon({open}) {
	return open ? (
		<svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-600" fill="none" aria-hidden="true">
			<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" stroke="currentColor" strokeWidth="1.6" />
			<path d="M15 9l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	) : (
		<svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-600" fill="none" aria-hidden="true">
			<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" stroke="currentColor" strokeWidth="1.6" />
			<circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
		</svg>
	);
}

function Spinner() {
	return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-transparent" aria-hidden="true" />;
}

function FieldIcon({children}) {
	return <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">{children}</div>;
}

function MailIcon() {
	return (
		<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
			<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z" stroke="currentColor" strokeWidth="1.6" />
			<path d="M6 7l6 5 6-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function LockIcon() {
	return (
		<svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
			<path d="M7.5 10V8.2A4.5 4.5 0 0 1 12 3.7a4.5 4.5 0 0 1 4.5 4.5V10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
			<path d="M6.5 10h11A2.5 2.5 0 0 1 20 12.5v5A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-5A2.5 2.5 0 0 1 6.5 10Z" stroke="currentColor" strokeWidth="1.6" />
		</svg>
	);
}

function Alert({variant = "error", title, children}) {
	const styles = variant === "error" ? "border-rose-200/60 bg-rose-50/70 text-rose-800" : "border-emerald-200/60 bg-emerald-50/70 text-emerald-900";

	const dot = variant === "error" ? "bg-rose-500" : "bg-emerald-500";

	return (
		<div className={`rounded-2xl border px-4 py-3 ${styles}`}>
			<div className="flex items-start gap-3">
				<span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot}`} />
				<div>
					<div className="text-sm font-semibold">{title}</div>
					<div className="text-xs mt-1 leading-relaxed">{children}</div>
				</div>
			</div>
		</div>
	);
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

	const subtitle = useMemo(() => (mode === "login" ? "Accedeix per analitzar i publicar." : "Registra’t per començar en 30 segons."), [mode]);

	const pwdScore = useMemo(() => {
		if (mode !== "register") return null;
		const p = password || "";
		let s = 0;
		if (p.length >= 6) s++;
		if (p.length >= 10) s++;
		if (/[A-Z]/.test(p)) s++;
		if (/[0-9]/.test(p)) s++;
		if (/[^A-Za-z0-9]/.test(p)) s++;
		return s;
	}, [password, mode]);

	const pwdLabel = useMemo(() => {
		if (pwdScore === null) return "";
		if (pwdScore <= 1) return "Feble";
		if (pwdScore <= 3) return "Correcta";
		return "Forta";
	}, [pwdScore]);

	const onSubmit = async e => {
		e.preventDefault();
		setError("");
		setOkMsg("");

		const em = email.trim();
		if (!em) return setError("Escriu un email.");
		if (!password) return setError("Escriu una contrasenya.");
		if (password.length < 6) return setError("La contrasenya ha de tenir mínim 6 caràcters.");

		setLoading(true);
		try {
			if (mode === "register") {
				await register({email: em, password});
				setOkMsg("Compte creat correctament.");
				setMode("login");
				setPassword("");
			} else {
				await login({email: em, password});
			}
		} catch (err) {
			setError(err?.message || "Error desconegut");
		} finally {
			setLoading(false);
		}
	};

	if (booting) {
		return (
			<div className="w-full mx-auto max-w-lg">
				<div className="rounded-[28px] border border-white/60 bg-white/70 backdrop-blur-xl shadow-2xl p-8">
					<div className="flex items-center gap-3">
						<span className="h-3 w-3 rounded-full bg-slate-300 animate-pulse" />
						<p className="text-sm text-slate-600">Carregant…</p>
					</div>
				</div>
			</div>
		);
	}

	if (token) return children;

	return (
		<div className="w-full mx-auto max-w-lg">
			{/* Outer glow */}
			<div className="relative">
				<div className="absolute -inset-1 rounded-[32px] bg-gradient-to-r from-emerald-400/25 via-indigo-400/25 to-rose-400/25 blur-xl" />
				{/* Card */}
				<div className="relative rounded-[32px] border border-white/60 bg-white/70 backdrop-blur-xl shadow-2xl overflow-hidden">
					{/* Top banner */}
					<div className="px-6 sm:px-8 pt-7 pb-5 border-b border-white/60 bg-white/40">
						<div className="flex items-start justify-between gap-4">
							<div>
								<div className="inline-flex items-center gap-2 rounded-full bg-white/70 border border-white/60 px-3 py-1 text-xs font-semibold text-slate-700">
									<span className="text-base leading-none"></span>
									Detector d’aus · Accés
								</div>
								<h2 className="mt-3 text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">{title}</h2>
								<p className="mt-1 text-sm text-slate-600">{subtitle}</p>
							</div>

							<div className="hidden sm:flex flex-col items-end">
								<div className="rounded-2xl bg-white/70 border border-white/60 px-3 py-2 text-xs text-slate-600">
									<div className="font-semibold text-slate-800">TFG</div>
									<div>Protegit</div>
								</div>
							</div>
						</div>

						{/* Mode switch */}
						<div className="mt-5 inline-flex w-full rounded-2xl bg-white/70 border border-white/60 p-1">
							<button
								type="button"
								onClick={() => {
									setMode("login");
									setError("");
									setOkMsg("");
								}}
								className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition
                ${mode === "login" ? "bg-indigo-600 text-white shadow" : "text-slate-700 hover:bg-white/70"}`}>
								Iniciar sessió
							</button>
							<button
								type="button"
								onClick={() => {
									setMode("register");
									setError("");
									setOkMsg("");
								}}
								className={`flex-1 px-4 py-2 rounded-xl text-sm font-semibold transition
                ${mode === "register" ? "bg-emerald-600 text-white shadow" : "text-slate-700 hover:bg-white/70"}`}>
								Registrar-se
							</button>
						</div>
					</div>

					{/* Body */}
					<div className="px-6 sm:px-8 py-6">
						<form onSubmit={onSubmit} className="space-y-4">
							{/* Email */}
							<div className="space-y-1.5">
								<label className="text-xs font-semibold text-slate-700">Email</label>
								<div className="relative">
									<FieldIcon>
										<MailIcon />
									</FieldIcon>
									<input
										value={email}
										onChange={e => setEmail(e.target.value)}
										type="email"
										inputMode="email"
										autoComplete="email"
										placeholder="tuemail@gmail.com"
										className="w-full rounded-2xl border border-slate-200/80 bg-white/90 pl-11 pr-4 py-3 text-sm outline-none
                      focus:ring-2 focus:ring-indigo-200 focus:border-indigo-200 transition
                      placeholder:text-slate-400"
									/>
								</div>
							</div>

							{/* Password */}
							<div className="space-y-1.5">
								<label className="text-xs font-semibold text-slate-700">Contrasenya</label>

								<div className="flex items-stretch gap-2">
									<div className="relative flex-1">
										<FieldIcon>
											<LockIcon />
										</FieldIcon>
										<input
											value={password}
											onChange={e => setPassword(e.target.value)}
											type={showPassword ? "text" : "password"}
											autoComplete={mode === "login" ? "current-password" : "new-password"}
											placeholder={mode === "register" ? "mínim 6 caràcters" : "la teva contrasenya"}
											className="w-full rounded-2xl border border-slate-200/80 bg-white/90 pl-11 pr-4 py-3 text-sm outline-none
                        focus:ring-2 focus:ring-indigo-200 focus:border-indigo-200 transition
                        placeholder:text-slate-400"
										/>
									</div>

									<button
										type="button"
										onClick={() => setShowPassword(v => !v)}
										className="shrink-0 rounded-2xl border border-slate-200/80 bg-white/90 px-4 text-sm hover:bg-white transition
                      focus:outline-none focus:ring-2 focus:ring-indigo-200"
										aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>
										<EyeIcon open={showPassword} />
									</button>
								</div>

								<div className="flex items-center justify-between gap-3">
									<p className="text-[11px] text-slate-500">Prem l’ull per mostrar/ocultar.</p>

									{mode === "register" && (
										<div className="flex items-center gap-2">
											<div className="h-1.5 w-24 rounded-full bg-slate-200 overflow-hidden">
												<div className={`h-full transition-all ${pwdScore <= 1 ? "w-1/5 bg-rose-500" : pwdScore <= 3 ? "w-3/5 bg-amber-500" : "w-full bg-emerald-500"}`} />
											</div>
											<span className="text-[11px] font-semibold text-slate-600">{pwdLabel}</span>
										</div>
									)}
								</div>
							</div>

							{/* Alerts */}
							{error && (
								<Alert variant="error" title="No s’ha pogut completar">
									{error}
								</Alert>
							)}

							{okMsg && (
								<Alert variant="ok" title="Tot correcte">
									{okMsg}
								</Alert>
							)}

							{/* Submit */}
							<button
								disabled={loading}
								type="submit"
								className={`w-full rounded-2xl py-3 text-sm font-extrabold text-white transition shadow
                  ${loading ? "bg-slate-400 cursor-not-allowed" : mode === "login" ? "bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99]" : "bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99]"}
                  focus:outline-none focus:ring-2 focus:ring-indigo-200`}>
								<span className="inline-flex items-center justify-center gap-2">
									{loading && <Spinner />}
									{loading ? "Processant…" : mode === "login" ? "Entrar" : "Crear compte"}
								</span>
							</button>
						</form>

						<div className="mt-6 flex items-center justify-center">
							<p className="text-[11px] text-slate-500">TFG · Detector d’aus · Accés protegit</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
