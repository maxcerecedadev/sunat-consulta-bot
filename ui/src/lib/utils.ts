import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { format } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getAssetUrl(path: string | null | undefined) {
  if (!path) return "";
  if (path.startsWith("blob:") || path.startsWith("http")) return path;

  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8000/api";
  const baseUrl = apiUrl.split("/api")[0].replace(/\/$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  return `${baseUrl}${cleanPath}`;
}

/**
 * Parses a YYYY-MM-DD string into a local Date object (avoiding timezone shifts)
 */
export const parseLocalDate = (dateStr: string) => {
  if (!dateStr || typeof dateStr !== "string") return undefined;
  const parts = dateStr.split("-");
  if (parts.length !== 3) return undefined;
  const [y, m, d] = parts.map(Number);
  return new Date(y, m - 1, d);
};

/**
 * Returns today's date as a YYYY-MM-DD string in local time
 */
export const getTodayString = () => format(new Date(), "yyyy-MM-dd");
