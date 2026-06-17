'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Upload, Play, Square, Download, Key, Trash2, Plus, RefreshCw,
  CheckCircle, XCircle, AlertCircle, HelpCircle, Zap, Clock,
  FileSpreadsheet, Settings, Loader2, Shield, Activity,
  RotateCcw
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

// ============ Types ============
interface BatchInfo {
  id: string;
  name: string;
  totalContacts: number;
  totalEmails: number;
  verifiedEmails: number;
  skippedEmails: number;
  status: string;
  currentColumn: number;
  createdAt: string;
  _count?: { contacts: number };
}

interface ApiKeyInfo {
  id: string;
  key: string;
  label: string | null;
  speedMs: number;
  dailyLimit: number;
  usedToday: number;
  lastResetDate: string | null;
  active: boolean;
  fullKeyLength: number;
}

interface StatusBreakdown {
  valid: number;
  invalid: number;
  'catch-all': number;
  'no-mx': number;
  unverifiable: number;
  error: number;
  pending: number;
  verifying: number;
  skipped: number;
}

interface VerificationStatus {
  isRunning: boolean;
  currentBatchId: string | null;
  currentColumn: number;
  stats: { verifiedThisRun: number; skippedThisRun: number; errorsThisRun: number; startTime: number };
  activeKeys?: number;
  rateLimited?: boolean;
  rateLimitBackoffSeconds?: number;
  consecutive429s?: number;
  batchProgress: {
    totalContacts: number;
    totalEmails: number;
    verifiedEmails: number;
    skippedEmails: number;
    currentColumn: number;
    status: string;
  } | null;
  statusBreakdown?: StatusBreakdown;
  keys: {
    total: number;
    usedToday: number;
    remainingToday: number;
    effectivePerSecond: number;
    effectivePerDay: number;
  };
  totalPending?: number;
  mxCheck?: {
    running: boolean;
    checked: number;
    total: number;
    noMxFound: number;
    emailsMarked: number;
    done: boolean;
    error: string;
  };
}

interface ContactInfo {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  company: string | null;
  domain: string;
  headCount: string | null;
  industry: string | null;
  location: string | null;
  email1: string | null;
  email2: string | null;
  email3: string | null;
  email4: string | null;
  email5: string | null;
  email6: string | null;
  status1: string;
  status2: string;
  status3: string;
  status4: string;
  status5: string;
  status6: string;
  message1: string | null;
  message2: string | null;
  message3: string | null;
  message4: string | null;
  message5: string | null;
  message6: string | null;
}

// ============ Status Badge ============
function StatusBadge({ status, message }: { status: string; message?: string | null }) {
  if (status.startsWith('skipped')) {
    const reason = status.replace('skipped-', '');
    return (
      <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200 text-[10px] gap-0.5 px-1.5 py-0">
        <Clock className="w-2.5 h-2.5" />
        Skip{reason ? ` (${reason})` : ''}
      </Badge>
    );
  }

  const config: Record<string, { icon: React.ReactNode; cls: string; label: string }> = {
    pending: { icon: <Clock className="w-2.5 h-2.5" />, cls: 'bg-gray-50 text-gray-500 border-gray-200', label: 'Pending' },
    verifying: { icon: <Loader2 className="w-2.5 h-2.5 animate-spin" />, cls: 'bg-blue-50 text-blue-600 border-blue-200', label: 'Verifying' },
    valid: { icon: <CheckCircle className="w-2.5 h-2.5" />, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Valid' },
    invalid: { icon: <XCircle className="w-2.5 h-2.5" />, cls: 'bg-red-50 text-red-700 border-red-200', label: 'Invalid' },
    unverifiable: { icon: <HelpCircle className="w-2.5 h-2.5" />, cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Unverifiable' },
    'catch-all': { icon: <Shield className="w-2.5 h-2.5" />, cls: 'bg-orange-50 text-orange-700 border-orange-200', label: 'Catch-All' },
    'no-mx': { icon: <AlertCircle className="w-2.5 h-2.5" />, cls: 'bg-purple-50 text-purple-700 border-purple-200', label: 'No MX' },
    error: { icon: <AlertCircle className="w-2.5 h-2.5" />, cls: 'bg-red-50 text-red-600 border-red-200', label: 'Error' },
  };

  const c = config[status] || config.pending;
  return (
    <Badge variant="outline" className={`${c.cls} text-[10px] gap-0.5 px-1.5 py-0`}>
      {c.icon}
      {c.label}
    </Badge>
  );
}

// ============ Column Names ============
const EMAIL_LABELS = [
  'firstname.lastname',
  'firstname',
  'lastname',
  'firstname.l',
  'f.lastname',
  'firstnamelastname',
];

const COL_LETTERS = ['I', 'K', 'M', 'O', 'Q', 'S'];
const STATUS_LETTERS = ['J', 'L', 'N', 'P', 'R', 'T'];

// ============ Main Page ============
export default function HomePage() {
  const { toast } = useToast();
  const [batches, setBatches] = useState<BatchInfo[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);
  const [verifyStatus, setVerifyStatus] = useState<VerificationStatus | null>(null);
  const [contacts, setContacts] = useState<ContactInfo[]>([]);
  const [contactsPage, setContactsPage] = useState(1);
  const [contactsTotal, setContactsTotal] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reverifying, setReverifying] = useState(false);
  const [mxChecking, setMxChecking] = useState(false);

  // Add key dialog
  const [newKey, setNewKey] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeySpeed, setNewKeySpeed] = useState(900);
  const [newKeyLimit, setNewKeyLimit] = useState(86000);
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyTestResult, setKeyTestResult] = useState<{ valid: boolean; message: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedBatchRef = useRef(selectedBatchId);
  useEffect(() => { selectedBatchRef.current = selectedBatchId; }, [selectedBatchId]);

  // Safe fetch wrapper
  const safeFetch = useCallback(async (url: string, opts?: RequestInit): Promise<any> => {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  const loadBatches = useCallback(() => {
    safeFetch('/api/batches').then(data => {
      if (data?.batches) {
        setBatches(data.batches);
        if (!selectedBatchRef.current && data.batches.length > 0) {
          setSelectedBatchId(data.batches[0].id);
        }
      }
    });
  }, [safeFetch]);

  const loadKeys = useCallback(() => {
    safeFetch('/api/keys').then(data => {
      if (data?.keys) setApiKeys(data.keys);
    });
  }, [safeFetch]);

  const loadStatus = useCallback(() => {
    safeFetch('/api/verify').then(data => {
      if (data) setVerifyStatus(data);
    });
  }, [safeFetch]);

  const loadContacts = useCallback(() => {
    const bid = selectedBatchRef.current;
    if (!bid) return;
    safeFetch(`/api/contacts?batchId=${bid}&page=${contactsPage}&limit=50`).then(data => {
      if (data?.contacts) {
        setContacts(data.contacts);
        setContactsTotal(data.total);
      }
    });
  }, [contactsPage, safeFetch]);

  // Initial load
  useEffect(() => { loadBatches(); loadKeys(); loadStatus(); }, [loadBatches, loadKeys, loadStatus]);
  useEffect(() => { loadContacts(); }, [loadContacts]);

  // Poll when verifying (2 sec) OR when MX pre-check is running
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (verifyStatus?.isRunning || verifyStatus?.mxCheck?.running) {
      pollRef.current = setInterval(() => {
        loadStatus();
        if (selectedBatchRef.current) loadContacts();
      }, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [verifyStatus?.isRunning, verifyStatus?.mxCheck?.running, loadStatus, loadContacts]);

  // Background status poll (15 sec)
  useEffect(() => {
    const iv = setInterval(loadStatus, 15000);
    return () => clearInterval(iv);
  }, [loadStatus]);

  // Auto-refresh batches (10 sec)
  useEffect(() => {
    const iv = setInterval(loadBatches, 10000);
    return () => clearInterval(iv);
  }, [loadBatches]);

  // Upload CSV
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await safeFetch('/api/upload', { method: 'POST', body: formData });
      if (data?.success) {
        toast({ title: 'Upload successful', description: `${data.batch.totalContacts} contacts, ${data.batch.totalEmails} emails generated.` });
        setSelectedBatchId(data.batch.id);
        loadBatches();
        loadContacts();
        // Run MX pre-check first (free — uses DNS, no API credits)
        // This runs in the background; we poll for completion before starting verification
        const mxStartData = await safeFetch('/api/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'precheck-mx', batchId: data.batch.id }),
        });
        if (mxStartData?.success) {
          toast({ title: 'MX Pre-Check started', description: 'Scanning domains for MX records before verification...' });
          // Poll for completion (up to 5 minutes)
          let mxDone = false;
          for (let i = 0; i < 150; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const statusData = await safeFetch('/api/verify');
            if (statusData?.mxCheck) {
              const mx = statusData.mxCheck;
              if (mx.done && !mx.running) {
                mxDone = true;
                if (mx.emailsMarked > 0) {
                  toast({ title: 'MX Pre-Check saved credits', description: `Marked ${mx.emailsMarked} emails as No MX — ${mx.emailsMarked} API credits saved!` });
                }
                loadBatches();
                loadStatus();
                break;
              }
            }
          }
          if (!mxDone) {
            toast({ title: 'MX Pre-Check still running', description: 'Starting verification anyway — MX pre-check will continue in background.' });
          }
        }
        // Then start verification (only for emails that still need API verification)
        if (!verifyStatus?.isRunning) {
          const startData = await safeFetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start', batchId: data.batch.id }),
          });
          if (startData?.success) {
            toast({ title: 'Verification auto-started', description: `Running with parallel key processing.` });
          } else if (startData) {
            toast({ title: 'Auto-start skipped', description: startData.message });
          }
        }
        loadStatus();
      } else {
        toast({ title: 'Upload failed', description: data?.error || 'Unknown error', variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Upload error', description: err.message, variant: 'destructive' });
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Start
  const handleStart = async () => {
    if (!selectedBatchId) {
      toast({ title: 'No batch selected', description: 'Upload a CSV first.', variant: 'destructive' });
      return;
    }
    setStarting(true);
    try {
      const data = await safeFetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', batchId: selectedBatchId }),
      });
      if (data?.success) {
        toast({ title: 'Verification started', description: data.message });
        loadStatus();
      } else {
        toast({ title: 'Cannot start', description: data?.message || 'Unknown error', variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
    setStarting(false);
  };

  // Stop
  const handleStop = async () => {
    setStopping(true);
    try {
      const data = await safeFetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      if (data?.success) {
        toast({ title: 'Verification stopped' });
        loadStatus();
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
    setStopping(false);
  };

  // Reverify errors
  const handleReverify = async () => {
    if (!selectedBatchId) return;
    setReverifying(true);
    try {
      const data = await safeFetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reverify', batchId: selectedBatchId, statuses: ['error'] }),
      });
      if (data?.success) {
        toast({ title: 'Reverify started', description: data.message });
        loadStatus();
        loadContacts();
      } else {
        toast({ title: 'Cannot reverify', description: data?.message || 'No errors to retry', variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
    setReverifying(false);
  };

  // MX Pre-Check
  const handleMxPreCheck = async () => {
    if (!selectedBatchId) {
      toast({ title: 'No batch selected', description: 'Upload a CSV first.', variant: 'destructive' });
      return;
    }
    setMxChecking(true);
    try {
      const data = await safeFetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'precheck-mx', batchId: selectedBatchId }),
      });
      if (data?.success) {
        toast({
          title: 'MX Pre-Check Started',
          description: 'Running in background. Progress will update automatically.',
        });
        // Poll for progress
        for (let i = 0; i < 180; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const statusData = await safeFetch('/api/verify');
          if (statusData?.mxCheck) {
            const mx = statusData.mxCheck;
            if (mx.done && !mx.running) {
              setMxChecking(false);
              if (mx.error) {
                toast({ title: 'MX Pre-Check Error', description: mx.error, variant: 'destructive' });
              } else {
                toast({
                  title: 'MX Pre-Check Complete',
                  description: `Marked ${mx.emailsMarked} emails as No MX — saving ${mx.emailsMarked} API credits!`,
                });
              }
              loadStatus();
              loadContacts();
              loadBatches();
              return;
            }
          }
        }
        setMxChecking(false);
        toast({ title: 'Still running', description: 'MX pre-check is still running. Check back later.' });
      } else {
        toast({ title: 'MX Pre-Check', description: data?.message || 'Unknown error', variant: 'destructive' });
        setMxChecking(false);
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
      setMxChecking(false);
    }
  };

  // Test API key
  const handleTestKey = async () => {
    if (!newKey.trim()) return;
    setTestingKey(true);
    setKeyTestResult(null);
    try {
      const data = await safeFetch('/api/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey.trim() }),
      });
      if (data) {
        setKeyTestResult({ valid: data.valid, message: data.message || data.error || 'Unknown result' });
      } else {
        setKeyTestResult({ valid: false, message: 'Could not reach the API' });
      }
    } catch {
      setKeyTestResult({ valid: false, message: 'Network error' });
    }
    setTestingKey(false);
  };

  // Add key
  const handleAddKey = async () => {
    if (!newKey.trim()) return;
    try {
      const data = await safeFetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: newKey.trim(), label: newKeyLabel.trim(), speedMs: newKeySpeed, dailyLimit: newKeyLimit }),
      });
      if (data?.success) {
        toast({ title: 'API key added' });
        setNewKey(''); setNewKeyLabel(''); setNewKeySpeed(900); setNewKeyLimit(86000);
        setAddKeyOpen(false); setKeyTestResult(null);
        loadKeys(); loadStatus();
      } else {
        toast({ title: 'Error', description: data?.error || 'Unknown error', variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  // Delete key
  const handleDeleteKey = async (id: string) => {
    try { await safeFetch(`/api/keys?id=${id}`, { method: 'DELETE' }); toast({ title: 'Key removed' }); loadKeys(); loadStatus(); } catch {}
  };

  // Toggle key
  const handleToggleKey = async (id: string, active: boolean) => {
    try { await safeFetch('/api/keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, active }) }); loadKeys(); loadStatus(); } catch {}
  };

  // Update key speed
  const handleUpdateKeySpeed = async (id: string, speedMs: number) => {
    try { await safeFetch('/api/keys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, speedMs }) }); loadKeys(); loadStatus(); } catch {}
  };

  // Delete batch
  const handleDeleteBatch = async (id: string) => {
    try { await safeFetch(`/api/batches?id=${id}`, { method: 'DELETE' }); if (selectedBatchId === id) setSelectedBatchId(null); loadBatches(); } catch {}
  };

  // Download
  const handleDownload = (batchId: string) => { window.open(`/api/download/${batchId}`, '_blank'); };

  // Selected batch
  const selectedBatch = batches.find(b => b.id === selectedBatchId);

  // Progress
  const totalProcessed = (verifyStatus?.batchProgress?.verifiedEmails || 0) + (verifyStatus?.batchProgress?.skippedEmails || 0);
  const totalEmails = verifyStatus?.batchProgress?.totalEmails || selectedBatch?.totalEmails || 0;
  const progressPct = totalEmails > 0 ? Math.round((totalProcessed / totalEmails) * 100) : 0;
  const curColLabel = verifyStatus?.currentColumn ? EMAIL_LABELS[verifyStatus.currentColumn - 1] : '';

  // Speed calculation
  const activeKeyCount = apiKeys.filter(k => k.active).length;
  const avgSpeedMs = activeKeyCount > 0 ? Math.round(apiKeys.filter(k => k.active).reduce((s, k) => s + k.speedMs, 0) / activeKeyCount) : 0;
  const effectivePerSecond = activeKeyCount > 0 ? activeKeyCount / (avgSpeedMs / 1000) : 0;
  const effectivePerDay = Math.round(effectivePerSecond * 86400);

  // Status breakdown
  const bd = verifyStatus?.statusBreakdown;
  const errorCount = bd?.error || 0;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-[1800px] mx-auto px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center shadow-sm">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-900 leading-tight">MailTester Ninja</h1>
              <p className="text-[10px] text-slate-500">Email Verification Engine</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {verifyStatus?.isRunning && verifyStatus?.rateLimited && (
              <div className="flex items-center gap-2 bg-orange-50 border border-orange-300 rounded-full px-3 py-1">
                <AlertCircle className="w-3.5 h-3.5 text-orange-600 animate-pulse" />
                <span className="text-[11px] font-medium text-orange-700">
                  Rate limited — backing off {verifyStatus.rateLimitBackoffSeconds}s (x{verifyStatus.consecutive429s})
                </span>
              </div>
            )}
            {verifyStatus?.isRunning && !verifyStatus?.rateLimited && (
              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-[11px] font-medium text-emerald-700">
                  Col {COL_LETTERS[verifyStatus.currentColumn - 1]} ({curColLabel}) · {verifyStatus.activeKeys || activeKeyCount} key{activeKeyCount !== 1 ? 's' : ''}
                </span>
              </div>
            )}
            <div className="text-[11px] text-slate-500 flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {effectivePerDay.toLocaleString()}/day
              {activeKeyCount ? ` · ${activeKeyCount} key${activeKeyCount > 1 ? 's' : ''}` : ''}
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-[1800px] mx-auto w-full px-4 py-3 space-y-3">
        <Tabs defaultValue="dashboard" className="w-full">
          <TabsList className="bg-white border h-9">
            <TabsTrigger value="dashboard" className="gap-1 text-xs px-3">
              <Activity className="w-3.5 h-3.5" /> Dashboard
            </TabsTrigger>
            <TabsTrigger value="spreadsheet" className="gap-1 text-xs px-3">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Spreadsheet
            </TabsTrigger>
            <TabsTrigger value="keys" className="gap-1 text-xs px-3">
              <Key className="w-3.5 h-3.5" /> API Keys
            </TabsTrigger>
          </TabsList>

          {/* ===== Dashboard ===== */}
          <TabsContent value="dashboard" className="space-y-3 mt-3">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Upload */}
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                    <Upload className="w-3.5 h-3.5" /> Upload CSV
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <input type="file" accept=".csv,.txt" onChange={handleUpload} ref={fileInputRef} className="hidden" />
                  <Button variant="outline" className="w-full h-16 border-dashed border-2 hover:border-emerald-400 hover:bg-emerald-50/50 text-xs" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Upload className="w-4 h-4 mr-1.5 text-slate-400" />}
                    {uploading ? 'Processing...' : 'Click to upload CSV'}
                  </Button>
                  <p className="text-[10px] text-slate-400 mt-1.5">Columns: First Name, Last Name, Website/Domain (required) + Job Title, Company, Head Count, Industry, Location</p>
                  <p className="text-[10px] text-emerald-500 mt-0.5">MX pre-check + verification auto-starts after upload</p>
                </CardContent>
              </Card>

              {/* Controls */}
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                    <Settings className="w-3.5 h-3.5" /> Controls
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3 space-y-2">
                  <Select value={selectedBatchId || ''} onValueChange={setSelectedBatchId}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select batch..." />
                    </SelectTrigger>
                    <SelectContent>
                      {batches.map(b => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.name} ({b._count?.contacts || b.totalContacts} contacts)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-1.5">
                    <Button size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-700 gap-1 h-8 text-xs" onClick={handleStart} disabled={starting || !selectedBatchId || verifyStatus?.isRunning}>
                      {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      {starting ? 'Starting...' : 'Start'}
                    </Button>
                    <Button size="sm" variant="destructive" className="flex-1 gap-1 h-8 text-xs" onClick={handleStop} disabled={stopping || !verifyStatus?.isRunning}>
                      {stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                      Stop
                    </Button>
                    {selectedBatchId && (
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => handleDownload(selectedBatchId)}>
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  {/* Reverify errors button */}
                  {errorCount > 0 && (
                    <Button size="sm" variant="outline" className="w-full gap-1 h-8 text-xs border-orange-300 text-orange-700 hover:bg-orange-50" onClick={handleReverify} disabled={reverifying || verifyStatus?.isRunning}>
                      {reverifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      Reverify Errors ({errorCount.toLocaleString()})
                    </Button>
                  )}
                  {/* MX Pre-Check button */}
                  <Button size="sm" variant="outline" className="w-full gap-1 h-8 text-xs border-purple-300 text-purple-700 hover:bg-purple-50" onClick={handleMxPreCheck} disabled={mxChecking || verifyStatus?.isRunning || !selectedBatchId}>
                    {mxChecking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
                    {mxChecking
                      ? `Checking MX... ${verifyStatus?.mxCheck?.checked || 0}/${verifyStatus?.mxCheck?.total || 0}`
                      : 'MX Pre-Check (Free)'}
                  </Button>
                  {verifyStatus?.mxCheck?.running && (
                    <div className="text-[9px] text-purple-600 text-center">
                      Found {(verifyStatus.mxCheck.noMxFound || 0).toLocaleString()} no-MX domains so far
                    </div>
                  )}
                  {!verifyStatus?.mxCheck?.running && (
                    <p className="text-[9px] text-purple-500 text-center">Saves API credits by marking No-MX domains before verification</p>
                  )}
                </CardContent>
              </Card>

              {/* Progress */}
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5" /> Progress
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="mb-2">
                    <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                      <span>{totalProcessed.toLocaleString()} / {totalEmails.toLocaleString()}</span>
                      <span>{progressPct}%</span>
                    </div>
                    <Progress value={progressPct} className="h-2" />
                  </div>
                  <div className="text-[10px] text-slate-500 text-center">
                    {(verifyStatus?.keys?.usedToday || 0).toLocaleString()} API calls today · {(verifyStatus?.totalPending || 0).toLocaleString()} pending across all batches
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Status Breakdown */}
            {bd && (
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-semibold">Status Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
                    <div className="bg-emerald-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-emerald-700">{(bd.valid || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-emerald-600">Valid</div>
                    </div>
                    <div className="bg-red-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-red-700">{(bd.invalid || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-red-600">Invalid</div>
                    </div>
                    <div className="bg-orange-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-orange-700">{(bd['catch-all'] || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-orange-600">Catch-All</div>
                    </div>
                    <div className="bg-purple-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-purple-700">{(bd['no-mx'] || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-purple-600">No MX</div>
                    </div>
                    <div className="bg-amber-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-amber-700">{(bd.unverifiable || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-amber-600">Unverifiable</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-gray-600">{(bd.skipped || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-gray-500">Skipped</div>
                    </div>
                    <div className="bg-red-50 rounded-lg p-2.5 text-center border border-red-200">
                      <div className="text-lg font-bold text-red-600">{(bd.error || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-red-500">Error</div>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-blue-600">{(bd.verifying || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-blue-500">Verifying</div>
                    </div>
                    <div className="bg-slate-50 rounded-lg p-2.5 text-center">
                      <div className="text-lg font-bold text-slate-500">{(bd.pending || 0).toLocaleString()}</div>
                      <div className="text-[10px] font-medium text-slate-400">Pending</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Batch list */}
            {batches.length > 0 && (
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-semibold">Batches</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3">
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {batches.map(b => (
                      <div key={b.id} className={`flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer transition-colors ${selectedBatchId === b.id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`} onClick={() => setSelectedBatchId(b.id)}>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{b.name}</div>
                          <div className="text-slate-400">{b._count?.contacts || b.totalContacts} contacts · {b.totalEmails} emails · Col {COL_LETTERS[b.currentColumn - 1]}</div>
                        </div>
                        <div className="flex items-center gap-1.5 ml-2">
                          <Badge variant="outline" className={b.status === 'completed' ? 'bg-emerald-50 text-emerald-700 text-[10px]' : b.status === 'verifying' ? 'bg-blue-50 text-blue-700 text-[10px]' : b.status === 'paused' ? 'bg-amber-50 text-amber-700 text-[10px]' : 'bg-slate-50 text-slate-600 text-[10px]'}>
                            {b.status}
                          </Badge>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={(e) => { e.stopPropagation(); handleDeleteBatch(b.id); }}>
                            <Trash2 className="w-3 h-3 text-slate-400" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ===== Spreadsheet ===== */}
          <TabsContent value="spreadsheet" className="mt-3">
            <Card>
              <CardHeader className="pb-2 pt-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                    <FileSpreadsheet className="w-3.5 h-3.5" /> Spreadsheet
                  </CardTitle>
                  <div className="flex items-center gap-1.5">
                    {errorCount > 0 && selectedBatchId && (
                      <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1 border-orange-300 text-orange-700" onClick={handleReverify} disabled={reverifying || verifyStatus?.isRunning}>
                        <RotateCcw className="w-3 h-3" /> Reverify Errors
                      </Button>
                    )}
                    {selectedBatchId && (
                      <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1" onClick={() => handleDownload(selectedBatchId)}>
                        <Download className="w-3 h-3" /> Export CSV
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1" onClick={loadContacts}>
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="px-2 pb-3">
                {!selectedBatchId ? (
                  <div className="text-center py-10 text-slate-400">
                    <FileSpreadsheet className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p className="text-xs">Upload a CSV to see the spreadsheet</p>
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto border rounded-lg">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-slate-50 hover:bg-slate-50">
                            <TableHead className="text-[10px] font-semibold min-w-[70px] sticky left-0 bg-slate-50 z-10">A: First</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[70px]">B: Last</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[80px]">C: Title</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[80px]">D: Company</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[100px]">E: Domain</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[50px]">F: HC</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[70px]">G: Industry</TableHead>
                            <TableHead className="text-[10px] font-semibold min-w-[70px]">H: Location</TableHead>
                            {EMAIL_LABELS.map((label, i) => (
                              <React.Fragment key={i}>
                                <TableHead className={`text-[10px] font-semibold min-w-[160px] ${verifyStatus?.currentColumn === i + 1 && verifyStatus?.isRunning ? 'bg-emerald-50' : ''}`}>
                                  {COL_LETTERS[i]}: {label}
                                </TableHead>
                                <TableHead className={`text-[10px] font-semibold min-w-[90px] ${verifyStatus?.currentColumn === i + 1 && verifyStatus?.isRunning ? 'bg-emerald-50' : ''}`}>
                                  {STATUS_LETTERS[i]}: Status
                                </TableHead>
                              </React.Fragment>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {contacts.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={20} className="text-center py-6 text-slate-400 text-xs">No contacts</TableCell>
                            </TableRow>
                          ) : (
                            contacts.map(c => (
                              <TableRow key={c.id} className="text-[11px] hover:bg-slate-50/50">
                                <TableCell className="font-medium py-1.5 sticky left-0 bg-white z-10">{c.firstName}</TableCell>
                                <TableCell className="font-medium py-1.5">{c.lastName}</TableCell>
                                <TableCell className="text-slate-500 py-1.5">{c.jobTitle || '-'}</TableCell>
                                <TableCell className="text-slate-500 py-1.5">{c.company || '-'}</TableCell>
                                <TableCell className="text-blue-600 font-mono text-[10px] py-1.5">{c.domain}</TableCell>
                                <TableCell className="py-1.5">{c.headCount || '-'}</TableCell>
                                <TableCell className="py-1.5">{c.industry || '-'}</TableCell>
                                <TableCell className="py-1.5">{c.location || '-'}</TableCell>
                                {([c.email1, c.email2, c.email3, c.email4, c.email5, c.email6] as (string | null)[]).map((email, i) => {
                                  const status = ([c.status1, c.status2, c.status3, c.status4, c.status5, c.status6] as string[])[i];
                                  return (
                                    <React.Fragment key={i}>
                                      <TableCell className={`font-mono text-[10px] py-1.5 ${verifyStatus?.currentColumn === i + 1 && verifyStatus?.isRunning && status === 'pending' ? 'bg-emerald-50/50' : ''}`}>
                                        {email || '-'}
                                      </TableCell>
                                      <TableCell className="py-1.5"><StatusBadge status={status} /></TableCell>
                                    </React.Fragment>
                                  );
                                })}
                              </TableRow>
                            ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <p className="text-[10px] text-slate-400">{contacts.length} of {contactsTotal.toLocaleString()} contacts</p>
                      <div className="flex gap-1">
                        <Button variant="outline" size="sm" disabled={contactsPage <= 1} onClick={() => setContactsPage(p => p - 1)} className="h-6 text-[10px]">Prev</Button>
                        <span className="text-[10px] text-slate-400 self-center px-1">{contactsPage}/{Math.max(1, Math.ceil(contactsTotal / 50))}</span>
                        <Button variant="outline" size="sm" disabled={contactsPage >= Math.ceil(contactsTotal / 50)} onClick={() => setContactsPage(p => p + 1)} className="h-6 text-[10px]">Next</Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== API Keys ===== */}
          <TabsContent value="keys" className="mt-3 space-y-3">
            <Card>
              <CardHeader className="pb-2 pt-3 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5" /> API Keys
                  </CardTitle>
                  <Dialog open={addKeyOpen} onOpenChange={(open) => { setAddKeyOpen(open); if (!open) setKeyTestResult(null); }}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="gap-1 h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700">
                        <Plus className="w-3 h-3" /> Add Key
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle className="text-sm">Add MailTester Ninja API Key</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-3 py-3">
                        <div>
                          <Label className="text-xs">API Key</Label>
                          <div className="flex gap-2">
                            <Input placeholder="Paste your MailTester Ninja key" value={newKey} onChange={e => { setNewKey(e.target.value); setKeyTestResult(null); }} className="h-8 text-xs flex-1" />
                            <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0" onClick={handleTestKey} disabled={testingKey || !newKey.trim()}>
                              {testingKey ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
                              {testingKey ? 'Testing...' : 'Test'}
                            </Button>
                          </div>
                          {keyTestResult && (
                            <div className={`mt-1.5 p-2 rounded text-[11px] ${keyTestResult.valid ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                              {keyTestResult.valid ? <CheckCircle className="w-3 h-3 inline mr-1" /> : <XCircle className="w-3 h-3 inline mr-1" />}
                              {keyTestResult.message}
                            </div>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs">Label (optional)</Label>
                          <Input placeholder="e.g., Pro Plan Key 1" value={newKeyLabel} onChange={e => setNewKeyLabel(e.target.value)} className="h-8 text-xs" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs">Speed (ms gap)</Label>
                            <Input type="number" value={newKeySpeed} onChange={e => setNewKeySpeed(parseInt(e.target.value) || 900)} className="h-8 text-xs" />
                            <p className="text-[10px] text-slate-400 mt-0.5">Pro: 900ms · Ultimate: 170ms</p>
                          </div>
                          <div>
                            <Label className="text-xs">Daily Limit</Label>
                            <Input type="number" value={newKeyLimit} onChange={e => setNewKeyLimit(parseInt(e.target.value) || 86000)} className="h-8 text-xs" />
                            <p className="text-[10px] text-slate-400 mt-0.5">Pro: 86,000 · Ultimate: 500,000</p>
                          </div>
                        </div>
                        <Button className="w-full bg-emerald-600 hover:bg-emerald-700 text-xs" onClick={handleAddKey} disabled={!newKey.trim()}>
                          Add Key
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-3">
                {apiKeys.length === 0 ? (
                  <div className="text-center py-6 text-slate-400">
                    <Key className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-xs">No API keys yet</p>
                    <p className="text-[10px] mt-0.5">Add your MailTester Ninja key to start verifying</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {apiKeys.map(k => (
                      <div key={k.id} className="flex items-center justify-between p-2.5 rounded-lg border bg-white">
                        <div className="flex items-center gap-2.5">
                          <Switch checked={k.active} onCheckedChange={(checked) => handleToggleKey(k.id, checked)} />
                          <div>
                            <div className="font-mono text-xs">{k.key}</div>
                            <div className="text-[10px] text-slate-400">{k.label || 'No label'} · {k.speedMs}ms gap · {k.dailyLimit.toLocaleString()}/day</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1">
                            <Label className="text-[10px] text-slate-400">Speed:</Label>
                            <Input type="number" value={k.speedMs} onChange={e => handleUpdateKeySpeed(k.id, parseInt(e.target.value) || 900)} className="h-6 w-16 text-[10px] px-1" min={100} max={5000} step={50} />
                            <span className="text-[10px] text-slate-400">ms</span>
                          </div>
                          <Badge variant="outline" className="text-[10px]">{k.usedToday.toLocaleString()} today</Badge>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleDeleteKey(k.id)}>
                            <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 mt-2">
                      <div className="text-[11px] font-medium text-blue-800">Parallel speed with {apiKeys.filter(k => k.active).length} key{apiKeys.filter(k => k.active).length !== 1 ? 's' : ''}</div>
                      <div className="text-[10px] text-blue-700 mt-0.5">
                        Each key runs independently. <strong>{effectivePerDay.toLocaleString()}</strong> emails/day ({effectivePerSecond.toFixed(1)}/sec).
                        Adding more keys multiplies your speed.
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t bg-white py-2 text-center">
        <p className="text-[10px] text-slate-400">MailTester Ninja Engine · Continuous parallel verification · Auto-resumes after restart</p>
      </footer>
    </div>
  );
}
