import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Settings as SettingsIcon, Moon, Sun, Database, Shield, AlertTriangle } from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { toast } from "@/hooks/use-toast";

const Settings = () => {
  const { theme, setTheme } = useTheme();
  const [safeOpsEnabled, setSafeOpsEnabled] = useState(true);
  const [confirmDestructive, setConfirmDestructive] = useState(true);
  const [dataRetentionDays, setDataRetentionDays] = useState("90");
  const [autoClosePositions, setAutoClosePositions] = useState(false);

  const handleSave = () => {
    toast({
      title: "Settings Saved",
      description: "Your preferences have been updated successfully.",
    });
  };

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Application preferences and configuration
        </p>
      </div>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Sun className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="font-mono">Appearance</CardTitle>
              <CardDescription>Customize the look and feel</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Theme</Label>
              <p className="text-sm text-muted-foreground">Select your preferred color scheme</p>
            </div>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Safe Operations */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="font-mono">Safe Operations</CardTitle>
              <CardDescription>Safety checks and confirmations</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable Safe-Ops Mode</Label>
              <p className="text-sm text-muted-foreground">Require confirmation for all critical actions</p>
            </div>
            <Switch checked={safeOpsEnabled} onCheckedChange={setSafeOpsEnabled} />
          </div>
          
          <Separator />
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Confirm Destructive Actions</Label>
              <p className="text-sm text-muted-foreground">Type-to-confirm for Close All, Kill Switch</p>
            </div>
            <Switch checked={confirmDestructive} onCheckedChange={setConfirmDestructive} />
          </div>
          
          <Separator />
          
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-Close on Daily Stop</Label>
              <p className="text-sm text-muted-foreground">Automatically close all positions when daily stop is hit</p>
            </div>
            <Switch checked={autoClosePositions} onCheckedChange={setAutoClosePositions} />
          </div>
        </CardContent>
      </Card>

      {/* Data Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="font-mono">Data Management</CardTitle>
              <CardDescription>Control data retention and storage</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Data Retention Period</Label>
              <p className="text-sm text-muted-foreground">Days to keep historical data</p>
            </div>
            <Select value={dataRetentionDays} onValueChange={setDataRetentionDays}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
                <SelectItem value="180">180 days</SelectItem>
                <SelectItem value="365">1 year</SelectItem>
                <SelectItem value="-1">Forever</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Runtime Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="font-mono">Runtime Configuration</CardTitle>
              <CardDescription>Backend connection settings</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>API Endpoint</Label>
            <Input 
              value="http://localhost:3001" 
              readOnly 
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">Trading engine REST API endpoint</p>
          </div>
          
          <Separator />
          
          <div className="space-y-2">
            <Label>WebSocket Endpoint</Label>
            <Input 
              value="ws://localhost:3001" 
              readOnly 
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">Real-time events stream</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} size="lg">
          Save Settings
        </Button>
      </div>
    </div>
  );
};

export default Settings;
