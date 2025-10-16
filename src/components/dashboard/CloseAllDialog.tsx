import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle } from "lucide-react";
import { useState, useEffect } from "react";

interface CloseAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  positionCount: number;
}

export const CloseAllDialog = ({
  open,
  onOpenChange,
  onConfirm,
  positionCount,
}: CloseAllDialogProps) => {
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [countdown, setCountdown] = useState(10);

  const CONFIRM_TOKEN = "CLOSE ALL";
  const isValid = confirmText === CONFIRM_TOKEN && understood && countdown === 0;

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setReason("");
      setUnderstood(false);
      setCountdown(10);

      const timer = setInterval(() => {
        setCountdown((prev) => Math.max(0, prev - 1));
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [open]);

  const handleConfirm = () => {
    if (isValid) {
      onConfirm(reason || "Manual close all");
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border-destructive/50 max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive text-xl">
            <AlertTriangle className="h-6 w-6" />
            Close All Positions
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-4 text-base">
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 space-y-2">
              <p className="font-semibold text-foreground">
                This will immediately close <span className="text-destructive font-bold">{positionCount}</span> open position{positionCount !== 1 ? 's' : ''}:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>Market orders will be submitted for all positions</li>
                <li>All pending limit orders will be cancelled</li>
                <li>Slippage may occur due to market conditions</li>
                <li>This action is logged and cannot be undone</li>
              </ul>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="reason" className="text-sm font-mono">
                  Reason (optional):
                </Label>
                <Input
                  id="reason"
                  placeholder="e.g., Risk management, market conditions..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="understood"
                  checked={understood}
                  onCheckedChange={(checked) => setUnderstood(checked as boolean)}
                />
                <label
                  htmlFor="understood"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  I understand this action cannot be undone
                </label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm" className="text-sm font-mono">
                  Type "<span className="font-bold text-destructive">{CONFIRM_TOKEN}</span>" to confirm:
                </Label>
                <Input
                  id="confirm"
                  placeholder={CONFIRM_TOKEN}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="font-mono font-bold"
                  disabled={countdown > 0}
                />
                {countdown > 0 && (
                  <p className="text-xs text-muted-foreground font-mono">
                    Unlocking in {countdown}s...
                  </p>
                )}
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isValid}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          >
            Confirm Close All
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
