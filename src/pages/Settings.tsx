import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Settings as SettingsIcon } from "lucide-react";

const Settings = () => {
  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Application preferences and configuration (coming soon)
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <SettingsIcon className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="font-mono">Application Settings</CardTitle>
              <CardDescription>Theme, data retention, and safe-ops toggles</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 space-y-3">
            <SettingsIcon className="h-16 w-16 text-muted-foreground" />
            <div className="text-center">
              <p className="font-semibold">Settings Panel</p>
              <p className="text-sm text-muted-foreground">Coming in Phase 3</p>
              <Badge variant="outline" className="mt-3">Phase 3 Feature</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Settings;
