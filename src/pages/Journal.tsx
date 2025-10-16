import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookOpen } from "lucide-react";

const Journal = () => {
  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Trading Journal</h1>
        <p className="text-muted-foreground mt-1">
          Notes, tags, and attachments per trade (coming soon)
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <BookOpen className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="font-mono">Trade Journal</CardTitle>
              <CardDescription>Document trading decisions and outcomes</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 space-y-3">
            <BookOpen className="h-16 w-16 text-muted-foreground" />
            <div className="text-center">
              <p className="font-semibold">Trading Journal</p>
              <p className="text-sm text-muted-foreground">Coming in Phase 3</p>
              <Badge variant="outline" className="mt-3">Phase 3 Feature</Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Journal;
