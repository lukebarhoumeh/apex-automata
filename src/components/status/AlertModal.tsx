/**
 * Alert Modal
 * 
 * Sprint 1.6: Modal dialog for critical alerts (kill switch, unexpected stop, backend down).
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, XCircle, ExternalLink } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { AlertDefinition } from '@/runtime/alerts/AlertController';

interface AlertModalProps {
  alert: AlertDefinition | null;
  onClose: () => void;
}

export function AlertModal({ alert, onClose }: AlertModalProps) {
  const navigate = useNavigate();

  if (!alert) return null;

  const getIcon = () => {
    switch (alert.severity) {
      case 'critical':
        return <XCircle className="h-6 w-6 text-destructive" />;
      case 'warning':
        return <AlertTriangle className="h-6 w-6 text-warning" />;
      default:
        return <AlertTriangle className="h-6 w-6 text-primary" />;
    }
  };

  const handleGoToRisk = () => {
    onClose();
    navigate('/risk');
  };

  return (
    <AlertDialog open={!!alert} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-3">
            {getIcon()}
            <span>{alert.title}</span>
          </AlertDialogTitle>
          <AlertDialogDescription className="text-left">
            {alert.message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        
        <div className="flex flex-col gap-2 py-2">
          {alert.key.startsWith('killswitch') && (
            <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
              <p className="font-semibold text-foreground mb-1">What happened?</p>
              <p>
                The kill switch was triggered to protect your account. 
                All new trading has been halted. You must manually reset 
                the kill switch from the Risk Controls page to resume trading.
              </p>
            </div>
          )}
          
          {alert.key.startsWith('unexpected_stop') && (
            <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
              <p className="font-semibold text-foreground mb-1">What to do?</p>
              <p>
                Check the backend logs for error details. You may need to 
                restart the trading engine manually after resolving the issue.
              </p>
            </div>
          )}

          {alert.key.startsWith('backend_down') && (
            <div className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
              <p className="font-semibold text-foreground mb-1">Connection lost</p>
              <p>
                The trading backend is not responding. Check if the backend 
                service is running and accessible.
              </p>
            </div>
          )}
        </div>

        <AlertDialogFooter className="flex-col sm:flex-row gap-2">
          <Button 
            variant="outline" 
            size="sm"
            onClick={handleGoToRisk}
            className="gap-1"
          >
            <ExternalLink className="h-3 w-3" />
            Go to Risk Controls
          </Button>
          <AlertDialogAction onClick={onClose}>
            Dismiss
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
