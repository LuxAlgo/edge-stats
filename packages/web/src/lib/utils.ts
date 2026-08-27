import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Compose class lists with Tailwind-aware conflict resolution (shadcn `cn`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
