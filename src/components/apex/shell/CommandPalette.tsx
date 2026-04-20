import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Download,
  Flag,
  Pause,
  Play,
  Power,
  Target,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Pill } from "@/components/apex/Pill";
import { NAV } from "./nav-config";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitchMode: (mode: "paper" | "live" | "paused") => void;
  onKillSwitch: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onSwitchMode,
  onKillSwitch,
}: CommandPaletteProps) {
  const navigate = useNavigate();

  const runAndClose = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Command or search…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Navigate">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.id}
                value={`nav ${item.label}`}
                onSelect={() => runAndClose(() => navigate(item.path))}
              >
                <Icon size={14} strokeWidth={1.6} className="mr-2" />
                <span className="flex-1">Go to {item.label}</span>
                <Pill tone="default">nav</Pill>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Mode">
          <CommandItem
            value="mode paper switch"
            onSelect={() => runAndClose(() => onSwitchMode("paper"))}
          >
            <ArrowRight size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Switch to Paper</span>
            <Pill tone="accent">mode</Pill>
          </CommandItem>
          <CommandItem
            value="mode live switch"
            onSelect={() => runAndClose(() => onSwitchMode("live"))}
          >
            <Play size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Switch to Live</span>
            <Pill tone="up">mode</Pill>
          </CommandItem>
          <CommandItem
            value="mode pause"
            onSelect={() => runAndClose(() => onSwitchMode("paused"))}
          >
            <Pause size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Pause bot</span>
            <Pill tone="warn">mode</Pill>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            value="flatten all positions kill switch"
            onSelect={() => runAndClose(onKillSwitch)}
          >
            <Power size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Flatten all positions</span>
            <Pill tone="down">danger</Pill>
          </CommandItem>
          <CommandItem
            value="export session pnl csv"
            onSelect={() =>
              runAndClose(() => {
                /* placeholder — wired in Phase 2 */
              })
            }
          >
            <Download size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Export session P&amp;L CSV</span>
            <Pill tone="default">export</Pill>
          </CommandItem>
          <CommandItem
            value="open strategy runner"
            onSelect={() => runAndClose(() => navigate("/signals"))}
          >
            <Target size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Open strategy runner</span>
            <Pill tone="default">action</Pill>
          </CommandItem>
          <CommandItem
            value="report a bug"
            onSelect={() => runAndClose(() => {})}
          >
            <Flag size={14} strokeWidth={1.6} className="mr-2" />
            <span className="flex-1">Report a bug</span>
            <Pill tone="default">action</Pill>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
