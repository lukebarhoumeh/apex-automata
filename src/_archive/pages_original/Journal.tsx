import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BookOpen, Plus, Search, Trash2, Edit, Calendar } from "lucide-react";
import { useJournalEntries, useCreateJournalEntry, useUpdateJournalEntry, useDeleteJournalEntry } from "@/hooks/useJournal";
import { format } from "date-fns";

const Journal = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: "",
    note: "",
  });

  const { data: entries, isLoading } = useJournalEntries({
    search: searchTerm,
    dateFrom,
    dateTo,
  });

  const createEntry = useCreateJournalEntry();
  const updateEntry = useUpdateJournalEntry();
  const deleteEntry = useDeleteJournalEntry();

  const handleSubmit = async () => {
    if (!formData.title.trim()) return;

    if (editingEntry) {
      await updateEntry.mutateAsync({
        id: editingEntry,
        input: formData,
      });
      setEditingEntry(null);
    } else {
      await createEntry.mutateAsync(formData);
    }

    setFormData({ title: "", note: "" });
    setIsDialogOpen(false);
  };

  const handleEdit = (entry: any) => {
    setFormData({
      title: entry.title,
      note: entry.note || "",
    });
    setEditingEntry(entry.id);
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this entry?")) {
      await deleteEntry.mutateAsync(id);
    }
  };

  const handleNewEntry = () => {
    setFormData({ title: "", note: "" });
    setEditingEntry(null);
    setIsDialogOpen(true);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">Trading Journal</h1>
          <p className="text-muted-foreground mt-1">
            Document insights, lessons, and trade retrospectives
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={handleNewEntry} className="gap-2 font-mono">
              <Plus className="h-4 w-4" />
              New Entry
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="font-mono">
                {editingEntry ? "Edit Entry" : "New Journal Entry"}
              </DialogTitle>
              <DialogDescription>
                Document your trading insights and lessons learned
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="title" className="font-mono">
                  Title
                </Label>
                <Input
                  id="title"
                  placeholder="e.g., BTC breakout trade analysis"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="font-mono"
                  maxLength={200}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="note" className="font-mono">
                  Notes
                </Label>
                <Textarea
                  id="note"
                  placeholder="Write your observations, lessons, or trade analysis..."
                  value={formData.note}
                  onChange={(e) => setFormData({ ...formData, note: e.target.value })}
                  className="min-h-[200px]"
                  maxLength={5000}
                />
                <p className="text-xs text-muted-foreground text-right">
                  {formData.note.length}/5000 characters
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!formData.title.trim() || createEntry.isPending || updateEntry.isPending}
                >
                  {editingEntry ? "Update" : "Create"} Entry
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono flex items-center gap-2">
            <Search className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="search" className="text-xs font-mono">
                Search
              </Label>
              <Input
                id="search"
                placeholder="Search entries..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dateFrom" className="text-xs font-mono">
                From Date
              </Label>
              <Input
                id="dateFrom"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="text-sm font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dateTo" className="text-xs font-mono">
                To Date
              </Label>
              <Input
                id="dateTo"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="text-sm font-mono"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Entries List */}
      {isLoading ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-muted-foreground">Loading entries...</div>
          </CardContent>
        </Card>
      ) : !entries || entries.length === 0 ? (
        <Card>
          <CardContent className="py-16">
            <div className="flex flex-col items-center justify-center text-center space-y-3">
              <BookOpen className="h-16 w-16 text-muted-foreground" />
              <div>
                <p className="font-semibold">No Journal Entries</p>
                <p className="text-sm text-muted-foreground">
                  Start documenting your trading journey
                </p>
              </div>
              <Button onClick={handleNewEntry} className="gap-2 font-mono mt-4">
                <Plus className="h-4 w-4" />
                Create First Entry
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="font-mono text-lg">{entry.title}</CardTitle>
                    <CardDescription className="flex items-center gap-2 mt-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(entry.created_at), "MMM dd, yyyy 'at' HH:mm")}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(entry)}
                      className="gap-2"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(entry.id)}
                      className="gap-2 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {entry.note && (
                <CardContent>
                  <Separator className="mb-4" />
                  <div className="prose prose-sm max-w-none">
                    <p className="whitespace-pre-wrap text-sm">{entry.note}</p>
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default Journal;
