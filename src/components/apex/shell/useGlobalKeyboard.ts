import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { NAV } from "./nav-config";

interface UseGlobalKeyboardArgs {
  onOpenPalette: () => void;
  onClosePalette: () => void;
}

function shouldIgnore(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useGlobalKeyboard({
  onOpenPalette,
  onClosePalette,
}: UseGlobalKeyboardArgs): void {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘/Ctrl + K: open palette. Works even when focus is in an input.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenPalette();
        return;
      }

      if (e.key === "Escape") {
        onClosePalette();
        return;
      }

      if (shouldIgnore(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toUpperCase();
      const entry =
        NAV.find((n) => n.kbd === key) ?? (e.key === "," ? NAV.find((n) => n.kbd === ",") : undefined);

      if (entry) {
        e.preventDefault();
        navigate(entry.path);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, onOpenPalette, onClosePalette]);
}
