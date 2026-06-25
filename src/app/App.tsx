import { RouterProvider } from "react-router";
import { Toaster } from "sonner";

import { AuthProvider } from "./auth/AuthProvider";
import { router } from "./routes";

export default function App() {
  return (
    <AuthProvider>
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
