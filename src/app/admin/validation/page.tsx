"use client";

import { useEffect, useState, useCallback } from 'react';
import { useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { AdminRoute } from '@/components/auth/AdminRoute';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { FilePreviewDialog } from '@/components/validation/FilePreviewDialog';
import { PersistentAiJob } from '@/components/validation/PersistentAiJob';
import { 
  Clock, 
  CheckCircle, 
  XCircle, 
  Users, 
  FileText, 
  Download, 
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  Filter as FilterIcon,
  Bug as BugIcon
} from 'lucide-react';
import { toast } from 'sonner';

interface AiJob {
  id: string;
  fileName: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  processedItems?: number;
  totalItems?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  user?: {
    name?: string;
    email?: string;
  };
}

interface StatsData {
  totalJobs: number;
  completedJobs: number;
  activeJobs: number;
  failedJobs: number;
}

// Shapes returned by /api/validation
type SheetName = 'qcm' | 'qroc' | 'cas_qcm' | 'cas_qroc';
interface GoodRow { sheet: SheetName; row: number; data: Record<string, any> }
interface BadRow { sheet: SheetName; row: number; reason: string; original: Record<string, any> }

export default function AdminValidationPage() {
  const [file, setFile] = useState<File | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    good: GoodRow[];
    bad: BadRow[];
    goodCount: number;
    badCount: number;
    sessionId?: string;
    fileName?: string;
  } | null>(null);

  const [allJobs, setAllJobs] = useState<AiJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [previewJob, setPreviewJob] = useState<AiJob | null>(null);
  const [statsData, setStatsData] = useState<StatsData>({
    totalJobs: 0,
    completedJobs: 0,
    activeJobs: 0,
    failedJobs: 0
  });
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 4;

  // Auto-refresh interval (ref-based to avoid state update loops)
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load jobs from API
  const loadJobs = useCallback(async () => {
    try {
      setJobsLoading(true);
      const response = await fetch('/api/validation/ai-progress?action=list');
      if (response.ok) {
        const data = await response.json();
        
        // Map the new API response to the expected format
        const mappedJobs = (data.jobs || []).map((job: any) => ({
          id: job.id,
          fileName: job.fileName || 'fichier.xlsx',
          status: job.phase === 'complete' ? 'completed' as const : 
                  job.phase === 'error' ? 'failed' as const :
                  job.phase === 'running' ? 'processing' as const : 'queued' as const,
          progress: job.progress || 0,
          message: job.message || '',
          processedItems: job.processedItems,
          totalItems: job.totalItems,
          createdAt: new Date(job.createdAt).toISOString(),
          startedAt: job.lastUpdated ? new Date(job.lastUpdated).toISOString() : undefined,
          completedAt: job.phase === 'complete' && job.lastUpdated ? new Date(job.lastUpdated).toISOString() : undefined,
          user: undefined // No user info in new API
        }));
        
        setAllJobs(mappedJobs);
        
        // Calculate stats
        const stats = {
          totalJobs: mappedJobs.length,
          completedJobs: mappedJobs.filter((j: AiJob) => j.status === 'completed').length,
          activeJobs: mappedJobs.filter((j: AiJob) => ['queued', 'processing'].includes(j.status)).length,
          failedJobs: mappedJobs.filter((j: AiJob) => j.status === 'failed').length
        };
        setStatsData(stats);
      }
    } catch (error) {
      console.error('Error loading jobs:', error);
      toast.error("Impossible de charger les jobs");
    } finally {
      setJobsLoading(false);
    }
  }, []);

  // Auto-refresh when there are active jobs
  useEffect(() => {
    // Only auto-refresh if there are active jobs (processing or queued)
    if (statsData.activeJobs > 0) {
      if (!refreshIntervalRef.current) {
        console.log(`🔄 Auto-refresh activated: ${statsData.activeJobs} active jobs`);
        refreshIntervalRef.current = setInterval(() => {
          loadJobs();
        }, 3000); // 3 second intervals
      }
    } else {
      if (refreshIntervalRef.current) {
        console.log('⏸️ Auto-refresh deactivated: no active jobs');
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    }

    return () => {
      // no-op here; explicit unmount cleanup below
    };
  }, [statsData.activeJobs, loadJobs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, []);

  // Load jobs on mount
  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Classic validation (Filter)
  const handleClassicValidation = async () => {
    if (!file) return;

    try {
      setValidating(true);
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/validation', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(err?.error || 'Validation failed');
      }

  const result = await response.json();
  setValidationResult(result);
      toast.success('Validation terminée', { description: `${result.goodCount} valides • ${result.badCount} erreurs` });
    } catch (error) {
      console.error('Classic validation error:', error);
      toast.error("Impossible de valider le fichier");
    } finally {
      setValidating(false);
    }
  };

  const downloadValidated = async (mode: 'good' | 'bad') => {
    if (!validationResult) return;
    try {
      // Prefer session-based download (no long URLs)
      if (validationResult.sessionId) {
        const res = await fetch(`/api/validation?mode=${mode}&sessionId=${validationResult.sessionId}`);
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `validation_${mode}.xlsx`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        return;
      }

      // Fallback to POST export with JSON body
      const res = await fetch('/api/validation/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, good: validationResult.good, bad: validationResult.bad })
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `validation_${mode}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Impossible de télécharger');
    }
  };

  const resetValidation = () => {
    setFile(null);
    setValidationResult(null);
  };

  // Download job result
  const downloadJobResult = async (job: AiJob) => {
    try {
      const response = await fetch(`/api/validation/ai-progress?aiId=${job.id}&action=download`);
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `enhanced_${job.fileName}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        
        toast.success("Le fichier amélioré a été téléchargé");
      }
    } catch (error) {
      console.error('Download error:', error);
      toast.error("Impossible de télécharger le fichier");
    }
  };

  // Status badge component
  const StatusBadge = ({ status }: { status: string }) => {
    const variants: Record<string, { color: string; icon: any }> = {
      queued: { color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300', icon: Clock },
      processing: { color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', icon: Clock },
      completed: { color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300', icon: CheckCircle },
      failed: { color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300', icon: XCircle },
      cancelled: { color: 'bg-gray-100 text-gray-800 dark:bg-gray-800/50 dark:text-gray-200', icon: XCircle },
    };

    const variant = variants[status] || variants.queued;
    const Icon = variant.icon;

    return (
      <Badge className={`${variant.color} border-0`}>
        <Icon className="w-3 h-3 mr-1" />
        {status === 'queued' ? 'En attente' :
         status === 'processing' ? 'En cours' :
         status === 'completed' ? 'Terminé' :
         status === 'failed' ? 'Échoué' :
         'Annulé'}
      </Badge>
    );
  };

  // Pagination
  const totalPages = Math.ceil(allJobs.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const displayedJobs = allJobs.slice(startIndex, startIndex + itemsPerPage);

  return (
    <ProtectedRoute requireAdmin>
      <AdminRoute>
        <AdminLayout>
          <div className="space-y-6">
            {/* Header */}
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold">Validation des Questions</h1>
                <p className="text-muted-foreground">Système de validation classique et IA</p>
              </div>
              <Button onClick={loadJobs} disabled={jobsLoading}>
                {jobsLoading ? 'Actualisation...' : 'Actualiser'}
              </Button>
            </div>

            {/* Statistics */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Jobs</CardTitle>
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{statsData.totalJobs}</div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Terminés</CardTitle>
                  <CheckCircle className="h-4 w-4 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-600">{statsData.completedJobs}</div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Actifs</CardTitle>
                  <Clock className="h-4 w-4 text-blue-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-blue-600">{statsData.activeJobs}</div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Échoués</CardTitle>
                  <XCircle className="h-4 w-4 text-red-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-red-600">{statsData.failedJobs}</div>
                </CardContent>
              </Card>
            </div>

            {/* Validation Section */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Classic Validation - Filter */}
              <Card>
                <CardHeader>
                  <CardTitle>Filter (Validation)</CardTitle>
                  <p className="text-sm text-muted-foreground">Vérification rapide et normalisation de votre classeur Excel</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Help Section */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3 dark:bg-blue-950/30 dark:border-blue-800">
                    <h4 className="font-medium text-blue-900 dark:text-blue-200">📋 Comment ça marche</h4>
                    <div className="text-sm text-blue-800 space-y-2 dark:text-blue-100">
                      <p><strong>Objectif :</strong> Vérifier que votre classeur est utilisable et identifier les erreurs avant l'import</p>
                      <p><strong>Feuilles acceptées :</strong> <code>qcm</code>, <code>qroc</code>, <code>cas qcm</code>, <code>cas qroc</code></p>
                      <p><strong>Vérifications :</strong></p>
                      <ul className="list-disc list-inside ml-4 space-y-1">
                        <li>Présence des colonnes requises par type de feuille</li>
                        <li>Réponses QCM valides (A–E) ou "?" / "Pas de réponse"</li>
                        <li>Réponses QROC non vides</li>
                        <li>Explications: facultatives (QCM/QROC/Cas clinique), si présentes on les conserve</li>
                      </ul>
                      <p><strong>Résultat :</strong> Liste des lignes valides vs invalides avec raisons d'erreur</p>
                    </div>
                  </div>

                  {/* File Upload */}
                  <div 
                    className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                      file ? 'border-green-500 bg-green-50 dark:bg-green-950/30 dark:border-green-400' : 'border-gray-300 hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-600'
                    }`}
                    onDrop={(e) => {
                      e.preventDefault();
                      const droppedFile = e.dataTransfer.files?.[0];
                      if (droppedFile && (droppedFile.name.endsWith('.xlsx') || droppedFile.name.endsWith('.xls') || droppedFile.name.endsWith('.csv'))) {
                        setFile(droppedFile);
                      }
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                    }}
                    onDragEnter={(e) => {
                      e.preventDefault();
                    }}
                  >
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      className="hidden"
                      id="classic-file"
                    />
                    <label htmlFor="classic-file" className="cursor-pointer">
                      <FileText className={`mx-auto h-12 w-12 ${file ? 'text-green-500' : 'text-gray-400 dark:text-gray-500'}`} />
                      <div className="mt-2">
                        <p className="text-sm font-medium">
                          {file ? file.name : 'Glissez-déposez votre fichier ici'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          ou cliquez pour sélectionner • Excel (.xlsx, .xls) ou CSV
                        </p>
                      </div>
                    </label>
                  </div>
                  
                  <div className="flex gap-2">
                    <Button 
                      onClick={handleClassicValidation} 
                      disabled={!file || validating}
                      className="w-full"
                    >
                      <FilterIcon className={`h-4 w-4 mr-2 ${validating ? 'animate-spin' : ''}`} />
                      {validating ? 'Filtrage...' : 'Filtrer maintenant'}
                    </Button>
                    {validationResult && (
                      <Button variant="ghost" onClick={resetValidation}>
                        Réinitialiser
                      </Button>
                    )}
                  </div>

                  {/* Results */}
                  {validationResult && (
                    <div className="mt-2 space-y-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge className="bg-green-100 text-green-800 border-0 dark:bg-green-900/30 dark:text-green-300">{validationResult.goodCount} valides</Badge>
                        <Badge className="bg-red-100 text-red-800 border-0 dark:bg-red-900/30 dark:text-red-300">{validationResult.badCount} erreurs</Badge>
                        <Button size="sm" variant="outline" onClick={() => downloadValidated('good')}>
                          <Download className="h-4 w-4 mr-2" /> Télécharger valides
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => downloadValidated('bad')}>
                          <Download className="h-4 w-4 mr-2" /> Télécharger erreurs
                        </Button>
                      </div>

                      {/* Bad rows preview */}
                      {validationResult.bad.length > 0 && (
                        <div className="border rounded-lg p-3 bg-red-50 dark:bg-red-900/20 dark:border-red-800">
                          <div className="flex items-center gap-2 mb-2">
                            <BugIcon className="h-4 w-4 text-red-600 dark:text-red-400" />
                            <span className="text-sm font-medium">Aperçu des erreurs (max 10)</span>
                          </div>
                          <ul className="list-disc ml-5 space-y-1 text-sm text-red-800 dark:text-red-200">
                            {validationResult.bad.slice(0, 10).map((r, idx) => (
                              <li key={idx}>
                                [{r.sheet}] ligne {r.row}: {r.reason}
                              </li>
                            ))}
                          </ul>
                          <p className="text-xs text-red-700 mt-2 dark:text-red-300">
                            Conseil: Téléchargez les erreurs, puis utilisez la section "AI Enrichment" pour corriger automatiquement.
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* AI Validation - AI Enrichment */}
              <Card>
                <CardHeader>
                  <CardTitle>AI Enrichment (Assistance IA)</CardTitle>
                  <p className="text-sm text-muted-foreground">Normalisation automatique des réponses et explications</p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* AI Help Section */}
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3 dark:bg-purple-900/20 dark:border-purple-800">
                    <h4 className="font-medium text-purple-900 dark:text-purple-200">🤖 Assistance IA</h4>
                    <div className="text-sm text-purple-800 space-y-2 dark:text-purple-100">
                      <p><strong>Astuce :</strong> Après le filtrage, téléchargez le fichier des erreurs et déposez-le ici pour correction automatique.</p>
                    </div>
                  </div>
                  
                  <PersistentAiJob onJobCreated={loadJobs} />
                </CardContent>
              </Card>
            </div>

            {/* Jobs Management */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Gestion des Jobs IA</span>
                  {statsData.activeJobs > 0 && (
                    <Badge variant="secondary" className="animate-pulse">
                      {statsData.activeJobs} actifs
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {displayedJobs.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Aucun job trouvé
                  </div>
                ) : (
                  <>
                    <div className="space-y-4">
                      {displayedJobs.map((job) => (
                        <div key={job.id} className="border rounded-lg p-4">
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-3">
                                <StatusBadge status={job.status} />
                                <span className="font-medium">{job.fileName}</span>
                                {job.user && (
                                  <span className="text-sm text-muted-foreground">
                                    par {job.user.name || job.user.email}
                                  </span>
                                )}
                              </div>
                              
                              {job.status === 'processing' && (
                                <div className="mt-2">
                                  <Progress value={job.progress} className="w-full" />
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {job.message} ({job.processedItems || 0}/{job.totalItems || 0})
                                  </p>
                                </div>
                              )}
                              
                              <p className="text-xs text-muted-foreground mt-1">
                                Créé le {new Date(job.createdAt).toLocaleString()}
                              </p>
                            </div>
                            
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setPreviewJob(job)}
                              >
                                Détails
                              </Button>
                              
                              {job.status === 'completed' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => downloadJobResult(job)}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              )}
                              
                              {/* Delete job (local only for now) */}
                              {/* ...existing Buttons... */}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="flex items-center justify-between mt-6">
                        <div className="text-sm text-muted-foreground">
                          Page {currentPage} sur {totalPages} ({allJobs.length} jobs au total)
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                            disabled={currentPage === 1}
                          >
                            <ChevronLeft className="h-4 w-4" />
                            Précédent
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                            disabled={currentPage === totalPages}
                          >
                            Suivant
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Preview Dialog */}
          {previewJob && (
            <FilePreviewDialog
              job={previewJob}
              open={!!previewJob}
              onOpenChange={() => setPreviewJob(null)}
            />
          )}
        </AdminLayout>
      </AdminRoute>
    </ProtectedRoute>
  );
}