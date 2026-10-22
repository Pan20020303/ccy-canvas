import { useMemo, useState } from "react";

import { resolveBackendAssetUrl } from "../reference-media";

type UserAvatarProps = {
  avatar?: string | null;
  name?: string | null;
  className?: string;
  fallbackClassName?: string;
};

export function UserAvatar({
  avatar,
  name,
  className = "h-7 w-7 rounded-full object-cover",
  fallbackClassName = "bg-cyan-500/20 text-cyan-200",
}: UserAvatarProps) {
  const [failedUrl, setFailedUrl] = useState("");
  const resolvedUrl = useMemo(
    () => resolveBackendAssetUrl(avatar, import.meta.env.VITE_API_BASE_URL ?? ""),
    [avatar],
  );
  const initial = name?.trim().slice(0, 1).toUpperCase() || "?";

  if (resolvedUrl && failedUrl !== resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={name?.trim() || "User avatar"}
        className={className}
        onError={() => setFailedUrl(resolvedUrl)}
      />
    );
  }

  return (
    <span
      aria-label={name?.trim() || "User avatar"}
      className={`flex items-center justify-center ${className} ${fallbackClassName}`}
    >
      {initial}
    </span>
  );
}
