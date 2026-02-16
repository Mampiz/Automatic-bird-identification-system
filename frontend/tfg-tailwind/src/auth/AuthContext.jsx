/* eslint-disable react-refresh/only-export-components */
import {createContext, useContext, useMemo, useState} from "react";
import { API_BASE } from "../lib/api";
const AuthContext = createContext(null);

function readStoredValue(key) {
	if (typeof window === "undefined") return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function AuthProvider({children}) {
	const [token, setToken] = useState(() => readStoredValue("token"));
	const [userEmail, setUserEmail] = useState(() => readStoredValue("userEmail"));
	const booting = false;

	const login = async ({email, password}) => {
		const form = new FormData();
		form.append("email", email);
		form.append("password", password);

		const res = await fetch(`${API_BASE}/auth/login`, {
			method: "POST",
			body: form
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.detail || data.error || "Error iniciando sesión");

		// tu backend normalmente devuelve { access_token, token_type, email }
		const accessToken = data.access_token || data.token || data.accessToken;
		const returnedEmail = data.email || email;

		if (!accessToken) throw new Error("Respuesta sin token");

		localStorage.setItem("token", accessToken);
		localStorage.setItem("userEmail", returnedEmail);

		setToken(accessToken);
		setUserEmail(returnedEmail);

		return data;
	};

	const register = async ({email, password}) => {
		const form = new FormData();
		form.append("email", email);
		form.append("password", password);

		const res = await fetch(`${API_BASE}/auth/register`, {
			method: "POST",
			body: form
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.detail || data.error || "Error registrando usuario");

		return data;
	};

	const logout = () => {
		localStorage.removeItem("token");
		localStorage.removeItem("userEmail");
		setToken(null);
		setUserEmail(null);
	};

	const value = useMemo(() => ({token, userEmail, booting, login, register, logout}), [token, userEmail, booting]);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
	return ctx;
}
