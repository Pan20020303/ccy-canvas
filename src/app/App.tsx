import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { Toaster } from "sonner";

import { AuthProvider } from "./auth/AuthProvider";
import { router } from "./routes";
import { useStore } from "./store";

/** Mirrors the store theme onto <html> so the globals.css light-theme
 *  overrides apply on EVERY route — this used to live in Navbar, which the
 *  homepage never mounts, so the lanyard pull-switch there flipped the store
 *  without recoloring the page. */
const ThemeSync = () => {
  const theme = useStore((state) => state.theme);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.classList.toggle("theme-light", theme === "light");
  }, [theme]);
  return null;
};

export default function App() {
  return (
    <AuthProvider>
      <ThemeSync />
      <RouterProvider router={router} />
      <Toaster
        position="top-center"
        theme="dark"
        toastOptions={{
          style: {
            background: "rgba(20, 22, 27, 0.92)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#e5e7eb",
            backdropFilter: "blur(16px)",
          },
        }}
      />
    </AuthProvider>
  );
}
