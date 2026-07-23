import { useState, useMemo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './App.css';
import { UNIQUE_ARTICLES, DEPOTS, ALL_DEPOTS, Article, Depot } from './data';
import { calculateDistribution, calculatePieceRemainderAllocation, Distribution, getFairnessRatio, getHarvestYear, reconstructDistributionsFromHistory } from './logic';
import HistoryView from './HistoryView';
import MasterDataView from './MasterDataView';
import { backupHistoryFiles, importHistoryFiles } from './backup';

type PrintRow = {
  id: string;
  articleName: string;
  unit: string;
  totalAmount: number;
  perHalb: number;
  perGanz: number;
};

type PrintOverviewRow = {
  id: string;
  articleName: string;
  unit: string;
  amountsByDepot: Record<string, number>;
};

function getArticleSelectionKey(article: Pick<Article, 'name' | 'unit'>): string {
  return `${article.name}__${article.unit}`;
}

function App() {
  const [activeTab, setActiveTab] = useState<'calculator' | 'history' | 'masterdata'>('calculator');
  const [distributions, setDistributions] = useState<Distribution[]>([]);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [availableYears, setAvailableYears] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState<string>('');
  const [historyReady, setHistoryReady] = useState(false);
  const [masterDataReady, setMasterDataReady] = useState(false);
  const restorationDone = useRef(false);

  // Fetch available years and always load ALL history on startup
  useEffect(() => {
    const initYears = async () => {
      try {
        const years = await invoke<string[]>('list_history_years');
        setAvailableYears(["Alle", ...years]);
        // Default to current harvest year
        const currentHarvestYear = getHarvestYear(
          `01.${String(new Date().getMonth() + 1).padStart(2, '0')}.${new Date().getFullYear()}`
        );
        setSelectedYear(years.includes(currentHarvestYear) ? currentHarvestYear : "Alle");
      } catch (e) {
        console.error("Failed to list history years:", e);
      }
    };
    initYears();
  }, []);

  // Load history whenever selectedYear changes
  useEffect(() => {
    if (selectedYear) {
      const loadData = async () => {
        try {
          const command = selectedYear === "Alle" ? 'load_all_history' : 'load_history';
          const args = selectedYear === "Alle" ? {} : { year: selectedYear };
          const raw = await invoke<string>(command, args);
          setHistoryData(JSON.parse(raw));
          setHistoryReady(true);
        } catch (e) {
          console.error("Failed to load history for year:", selectedYear, e);
        }
      };
      loadData();
    }
  }, [selectedYear]);

  const [editableArticles, setEditableArticlesRaw] = useState<Article[]>(UNIQUE_ARTICLES);
  const [editableDepots, setEditableDepotsRaw] = useState<Depot[]>(DEPOTS);

  // Initial load from backend JSON file only
  useEffect(() => {
    const initMasterData = async () => {
      try {
        const raw = await invoke<string>('load_master_data');
        const parsed = JSON.parse(raw);

        let initialArticles = UNIQUE_ARTICLES;
        let initialDepots = DEPOTS;

        // Source of truth: stammdaten.json
        if (parsed.articles && Array.isArray(parsed.articles) && parsed.articles.length > 0) {
          initialArticles = parsed.articles;
        }

        if (parsed.depots && Array.isArray(parsed.depots) && parsed.depots.length > 0) {
          initialDepots = parsed.depots;
        }

        setEditableArticlesRaw(initialArticles);
        setEditableDepotsRaw(initialDepots);
        setMasterDataReady(true);
      } catch (e) {
        console.error("Failed to load master data from backend:", e);
      }
    };
    initMasterData();
  }, []);

  // On startup: if today's history entries exist, restore them as the current distribution.
  useEffect(() => {
    if (restorationDone.current) return;
    if (!historyReady || !masterDataReady) return;

    restorationDone.current = true;

    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;
    const todayRows = historyData.filter(row => row.datum === todayStr);
    if (todayRows.length === 0) return;

    const restored = reconstructDistributionsFromHistory(todayRows, editableDepots);
    if (restored.length > 0) {
      setDistributions(restored);
    }
  }, [historyReady, masterDataReady, historyData, editableDepots]);

  const setEditableArticles = (articles: Article[]) => {
    setEditableArticlesRaw(articles);
    // Persist exclusively to stammdaten.json via backend.
    invoke('save_master_data', {
      articlesJson: JSON.stringify(articles),
      depotsJson: JSON.stringify(editableDepots)
    }).catch(console.error);
  };

  const setEditableDepots = (depots: Depot[]) => {
    setEditableDepotsRaw(depots);
    // Persist exclusively to stammdaten.json via backend.
    invoke('save_master_data', {
      articlesJson: JSON.stringify(editableArticles),
      depotsJson: JSON.stringify(depots)
    }).catch(console.error);
  };

  const selectedArticleDefault = editableArticles[0] ? getArticleSelectionKey(editableArticles[0]) : '';
  const [selectedArticle, setSelectedArticle] = useState<string>(selectedArticleDefault);
  const [amount, setAmount] = useState<number | ''>('');

  useEffect(() => {
    if (editableArticles.length === 0) {
      if (selectedArticle !== '') setSelectedArticle('');
      return;
    }

    const hasSelectedArticle = editableArticles.some(article => getArticleSelectionKey(article) === selectedArticle);
    if (!hasSelectedArticle) {
      setSelectedArticle(getArticleSelectionKey(editableArticles[0]));
    }
  }, [editableArticles, selectedArticle]);

  const fairnessByArticle = useMemo(() => {
    const map: Record<string, Record<string, 'viel' | 'wenig' | 'normal'>> = {};
    for (const d of distributions) {
      if (!map[d.articleName]) {
        map[d.articleName] = getFairnessRatio(d.articleName, historyData, editableDepots);
      }
    }
    return map;
  }, [distributions, editableDepots]);

  const getRemainderAllocation = (dist: Distribution) => {
    if (dist.unit !== 'Stück') {
      return {
        allocationsByDepot: {},
        distributedAmount: 0,
        openRemainder: dist.remainder,
        rounds: 0
      };
    }
    return calculatePieceRemainderAllocation(dist.remainder, dist.geschenkeDepotKuerzel, dist.excludedDepots, editableDepots);
  };

  const handleAddHarvest = () => {
    if (typeof amount !== 'number' || amount <= 0) return;
    const article = editableArticles.find(a => getArticleSelectionKey(a) === selectedArticle) as Article;
    if (!article) return;

    // Check if already exists
    if (distributions.find(d => d.articleName === article.name && d.unit === article.unit)) {
      alert("Artikel wurde bereits zur Ernte hinzugefügt!");
      return;
    }

    const newDist = calculateDistribution(article.name, article.unit, amount, [], editableDepots);
    setDistributions(prev => [newDist, ...prev]);
    setAmount('');
  };

  const handleToggleExclusion = (distId: string, depotKuerzel: string) => {
    setDistributions(distributions.map(dist => {
      if (dist.id === distId) {
        let newExcluded = [...dist.excludedDepots];
        if (newExcluded.includes(depotKuerzel)) {
          newExcluded = newExcluded.filter(x => x !== depotKuerzel);
        } else {
          if (newExcluded.length === editableDepots.length - 1) {
            alert("Mindestens ein Depot muss aktiv bleiben!");
            return dist;
          }
          newExcluded.push(depotKuerzel);
        }

        let recalcDist = calculateDistribution(dist.articleName, dist.unit, dist.totalHarvested, newExcluded, editableDepots);
        recalcDist.id = dist.id;
        recalcDist.geschenkeDepotKuerzel = (
          recalcDist.unit === 'Stück' && recalcDist.remainder > 0
            ? dist.geschenkeDepotKuerzel.filter(kuerzel => !newExcluded.includes(kuerzel))
            : []
        );
        return recalcDist;
      }
      return dist;
    }));
  };

  const handleSelectGeschenk = (distId: string, depotKuerzel: string, shouldSelect: boolean) => {
    setDistributions(distributions.map(dist => {
      if (dist.id === distId) {
        const nextSelection = shouldSelect
          ? Array.from(new Set([...dist.geschenkeDepotKuerzel, depotKuerzel]))
          : dist.geschenkeDepotKuerzel.filter(k => k !== depotKuerzel);
        return { ...dist, geschenkeDepotKuerzel: nextSelection };
      }
      return dist;
    }));
  };

  const handleSelectAllGeschenkDepots = (distId: string) => {
    setDistributions(distributions.map(dist => {
      if (dist.id !== distId) return dist;

      const selectableDepots = dist.results
        .filter(res => !res.isExcluded)
        .map(res => editableDepots.find(d => d.kuerzel === res.depotKuerzel))
        .filter((depot): depot is Depot => !!depot && depot.gesamtHalbeAnteile > 0)
        .map(depot => depot.kuerzel);

      return { ...dist, geschenkeDepotKuerzel: selectableDepots };
    }));
  };

  const handleClearGeschenkDepots = (distId: string) => {
    setDistributions(distributions.map(dist => dist.id === distId ? { ...dist, geschenkeDepotKuerzel: [] } : dist));
  };

  const handleDeleteDistribution = (distId: string) => {
    setDistributions(distributions.filter(d => d.id !== distId));
  };

  const handleUpdateAmount = (distId: string, newAmount: number) => {
    if (newAmount < 0) return;
    setDistributions(distributions.map(dist => {
      if (dist.id === distId) {
        let recalcDist = calculateDistribution(dist.articleName, dist.unit, newAmount, dist.excludedDepots, editableDepots);
        recalcDist.id = dist.id;
        recalcDist.geschenkeDepotKuerzel = (
          recalcDist.unit === 'Stück' && recalcDist.remainder > 0
            ? dist.geschenkeDepotKuerzel.filter(kuerzel => !recalcDist.excludedDepots.includes(kuerzel))
            : []
        );
        return recalcDist;
      }
      return dist;
    }));
  };

  const [printMode, setPrintMode] = useState<'overview' | 'depots' | null>(null);

  const handleBackupHistory = async () => {
    if (selectedYear === 'Alle') {
      alert('Bitte wählen Sie ein spezifisches Erntejahr aus, um ein Backup zu erstellen.');
      return;
    }
    const success = await backupHistoryFiles(selectedYear);
    if (success) {
      alert(`Backup für ${selectedYear} erfolgreich erstellt!`);
    } else {
      alert('Fehler beim Erstellen des Backups. Weitere Informationen finden Sie in der Konsole.');
    }
  };

  const handleImportHistory = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const fileArray = Array.from(files);
    const success = await importHistoryFiles(fileArray);
    
    if (success) {
      alert(`${fileArray.length} Datei(en) erfolgreich importiert!`);
      // Reload history data to reflect changes
      const command = selectedYear === "Alle" ? 'load_all_history' : 'load_history';
      const args = selectedYear === "Alle" ? {} : { year: selectedYear };
      const raw = await invoke<string>(command, args);
      setHistoryData(JSON.parse(raw));
    } else {
      alert('Fehler beim Importieren der Dateien. Weitere Informationen finden Sie in der Konsole.');
    }
  };

  const round2 = (value: number) => Math.round(value * 100) / 100;
  const toNetKg = (gross: number) => round2(gross * 0.95);

  const formatPrintAmount = (value: number, unit: string, forceGrams = false) => {
    if (unit === 'Stück') return Math.round(value).toString();
    if (unit === 'kg' && forceGrams) return Math.round(value * 1000).toString();
    return value.toFixed(2);
  };

  const formatPrintUnit = (unit: string, forceGrams = false) => {
    if (unit === 'Stück') return 'St.';
    if (unit === 'kg' && forceGrams) return 'g';
    return unit;
  };

  const printData = useMemo(() => {
    const byDepot: Record<string, PrintRow[]> = {};
    const overviewRows: PrintOverviewRow[] = [];

    for (const depot of editableDepots) {
      byDepot[depot.kuerzel] = [];
    }

    for (const dist of distributions) {
      const allocation = getRemainderAllocation(dist);
      const amountsByDepot: Record<string, number> = {};
      let hasAnyAmount = false;

      for (const depot of editableDepots) {
        const res = dist.results.find(r => r.depotKuerzel === depot.kuerzel);
        const isExcluded = !!res?.isExcluded;
        const baseAmount = !isExcluded ? (res?.calculatedAmount || 0) : 0;
        const allocatedRemainder = allocation.allocationsByDepot[depot.kuerzel] || 0;
        const totalDepotAmount = baseAmount + allocatedRemainder;

        if (isExcluded || totalDepotAmount <= 0) continue;

        const perHalb = totalDepotAmount / depot.gesamtHalbeAnteile;
        byDepot[depot.kuerzel].push({
          id: dist.id,
          articleName: dist.articleName,
          unit: dist.unit,
          totalAmount: totalDepotAmount,
          perHalb,
          perGanz: perHalb * 2
        });

        amountsByDepot[depot.kuerzel] = totalDepotAmount;
        hasAnyAmount = true;
      }

      if (hasAnyAmount) {
        overviewRows.push({
          id: dist.id,
          articleName: dist.articleName,
          unit: dist.unit,
          amountsByDepot
        });
      }
    }

    const sortRows = (rows: PrintRow[]) => {
      rows.sort((a, b) => {
        if (a.unit !== b.unit) return a.unit === 'Stück' ? -1 : 1;
        return a.articleName.localeCompare(b.articleName);
      });
    };

    for (const depot of editableDepots) {
      sortRows(byDepot[depot.kuerzel]);
    }
    overviewRows.sort((a, b) => {
      if (a.unit !== b.unit) return a.unit === 'Stück' ? -1 : 1;
      return a.articleName.localeCompare(b.articleName);
    });

    return { byDepot, overviewRows };
  }, [distributions, editableDepots]);

  const handlePrint = async (mode: 'overview' | 'depots') => {
    if (activeTab !== 'calculator' || distributions.length === 0) return;

    const today = new Date();
    const todayStr = `${String(today.getDate()).padStart(2, '0')}.${String(today.getMonth() + 1).padStart(2, '0')}.${today.getFullYear()}`;

    // Re-print on the same day should replace that day's rows instead of appending.
    let updatedHistory = historyData.filter(row => row.datum !== todayStr);

    for (const dist of distributions) {
      for (const depot of editableDepots) {
        const res = dist.results.find(r => r.depotKuerzel === depot.kuerzel);
        const isExcluded = res?.isExcluded;
        const calculatedAmount = res?.calculatedAmount || 0;
        const remainderAllocation = getRemainderAllocation(dist);
        const allocatedRemainder = remainderAllocation.allocationsByDepot[depot.kuerzel] || 0;

        let finalTotalAmount = calculatedAmount;
        finalTotalAmount += allocatedRemainder;

        if (!isExcluded && finalTotalAmount > 0) {
          const amountForHistory = dist.unit === 'kg' ? toNetKg(finalTotalAmount) : finalTotalAmount;
          const halberAnteilVal = amountForHistory / depot.gesamtHalbeAnteile;

          updatedHistory.push({
            datum: todayStr,
            depot: depot.name,
            artikel: dist.articleName,
            gesamtMenge: amountForHistory,
            ganzerAnteil: halberAnteilVal * 2,
            halberAnteil: halberAnteilVal,
            einheit: dist.unit
          });
        }
      }
    }

    const year = getHarvestYear(todayStr);

    // Safety: only sync rows belonging to the current target harvest year
    const jsonForSync = updatedHistory.filter(row => getHarvestYear(row.datum) === year);
    const jsonContent = JSON.stringify(jsonForSync, null, 2);

    try {
      await invoke('sync_history', { year, jsonContent });
    } catch (e) {
      console.error("Failed to sync history:", e);
      alert("Achtung: Konnte die Historie nicht dauerhaft speichern! Läuft das Backend?");
    }

    setPrintMode(mode);
    setTimeout(() => {
      window.print();
      setPrintMode(null);
    }, 500);
  };

  if (printMode) {
    const printDate = new Date().toLocaleDateString('de-DE');

    return (
      <div className="print-preview-overlay" style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        overflow: 'auto',
        padding: '2rem'
      }}>
        <div className="print-preview-paper" style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
          width: '100%',
          maxWidth: '1200px',
          padding: '2rem'
        }}>
          <style>
            {`
              @media print {
                @page {
                  size: ${printMode === 'overview' ? 'landscape' : 'portrait'};
                  margin: 1cm;
                }
              }
            `}
          </style>
          <div className="print-layout">
            {printMode === 'overview' && (
              <section className="print-summary-block">
                <h2>Gesamtverteilung über alle Depots</h2>
                <p style={{ marginBottom: '1rem', color: '#666' }}>Datum: {printDate}</p>
                <table className="print-overview-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginBottom: '1.5rem' }}>
                  <thead>
                    <tr>
                      <th style={{ borderBottom: '2px solid black', padding: '8px' }}>Artikel</th>
                      {editableDepots.map(depot => (
                        <th key={`overview-header-${depot.kuerzel}`} style={{ borderBottom: '2px solid black', padding: '8px' }}>
                          {depot.kuerzel}
                        </th>
                      ))}
                      <th style={{ borderBottom: '2px solid black', padding: '8px' }}>Summe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {printData.overviewRows.map(row => (
                      <tr key={`overall-${row.id}`}>
                        <td style={{ borderBottom: '1px solid #ddd', padding: '8px' }}><strong>{row.articleName}</strong></td>
                        {editableDepots.map(depot => {
                          const amount = row.amountsByDepot[depot.kuerzel] || 0;
                          return (
                            <td key={`overview-cell-${row.id}-${depot.kuerzel}`} style={{ borderBottom: '1px solid #ddd', padding: '8px' }}>
                              {amount > 0 ? `${formatPrintAmount(amount, row.unit)} ${formatPrintUnit(row.unit)}` : '-'}
                            </td>
                          );
                        })}
                        <td style={{ borderBottom: '1px solid #ddd', padding: '8px', fontWeight: 600 }}>
                          {`${formatPrintAmount(
                            editableDepots.reduce((sum, depot) => sum + (row.amountsByDepot[depot.kuerzel] || 0), 0),
                            row.unit
                          )} ${formatPrintUnit(row.unit)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {printData.overviewRows.length === 0 && <p>Keine Ernte eingetragen.</p>}
              </section>
            )}

            {printMode === 'depots' && editableDepots.map(depot => {
              const rows = printData.byDepot[depot.kuerzel] || [];

              return (
                <section key={depot.kuerzel} className="print-depot-block">
                  <h2>Depot: {depot.name}</h2>
                  <p style={{ marginBottom: '1rem', color: '#666', display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                    <span>Gesamt: {depot.gesamtHalbeAnteile} Halbe Anteile ({depot.halbeAnteile} Halbe, {depot.ganzeAnteile} Ganze)</span>
                    <span style={{ marginLeft: 'auto', textAlign: 'right' }}>Datum: {printDate}</span>
                  </p>

                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginBottom: '1.5rem' }}>
                    <thead>
                      <tr>
                        <th style={{ borderBottom: '2px solid black', padding: '8px' }}>Artikel</th>
                        <th style={{ borderBottom: '2px solid black', padding: '8px' }}>Gesamtmenge</th>
                        <th style={{ borderBottom: '2px solid black', padding: '8px' }}>Einen halben Anteil</th>
                        <th style={{ borderBottom: '2px solid black', padding: '8px' }}>Einen ganzen Anteil</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => (
                        <tr key={`${depot.kuerzel}-${row.id}`}>
                          <td style={{ borderBottom: '1px solid #ddd', padding: '8px' }}><strong>{row.articleName}</strong></td>
                          <td style={{ borderBottom: '1px solid #ddd', padding: '8px' }}>
                            {formatPrintAmount(row.unit === 'kg' ? toNetKg(row.totalAmount) : row.totalAmount, row.unit, true)} {formatPrintUnit(row.unit, true)}
                          </td>
                          <td style={{ borderBottom: '1px solid #ddd', padding: '8px' }}>
                            {formatPrintAmount(row.unit === 'kg' ? toNetKg(row.perHalb) : row.perHalb, row.unit, true)} {formatPrintUnit(row.unit, true)}
                          </td>
                          <td style={{ borderBottom: '1px solid #ddd', padding: '8px' }}>
                            {formatPrintAmount(row.unit === 'kg' ? toNetKg(row.perGanz) : row.perGanz, row.unit, true)} {formatPrintUnit(row.unit, true)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {rows.length === 0 && <p>Keine Ernte für dieses Depot erfasst.</p>}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout compact-mode">
      <header className="nav-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="header-left" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <img
            src="/app_logo.png"
            alt="Auf dem Acker e.V. Logo"
            className="app-logo"
          />
          <div>
            <h1 style={{ color: 'var(--color-primary)' }}>
              AckerApp
              <span style={{ fontSize: '0.55em', fontWeight: 'normal', color: 'var(--color-text-light)', marginLeft: '0.4rem' }}>
                v{__APP_VERSION__}
              </span>
            </h1>
            <p style={{ color: 'var(--color-text-light)' }}>Offline Depot-Verwaltung &amp; Ernteplanung</p>
          </div>
        </div>

        <div className="header-controls" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div className="tab-group" style={{ display: 'flex', gap: '1rem', background: 'var(--color-surface-solid)', padding: '0.4rem', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
            <button
              className={`tab-button ${activeTab === 'calculator' ? 'active' : ''}`}
              onClick={() => setActiveTab('calculator')}
            >
              🌾 Aktuelle Verteilung
            </button>
            <button
              className={`tab-button ${activeTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTab('history')}
            >
              📊 Historie &amp; Statistik
            </button>
            <button
              className={`tab-button ${activeTab === 'masterdata' ? 'active' : ''}`}
              onClick={() => setActiveTab('masterdata')}
            >
              ⚙️ Stammdaten
            </button>
          </div>

          <div className="year-select-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--color-surface-solid)', padding: '0.4rem 0.8rem', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-light)' }}>Erntejahr:</span>
            <select
              className="input"
              style={{ width: 'auto', padding: '2px 8px', fontSize: '0.9rem', fontWeight: 600, border: 'none', background: 'transparent' }}
              value={selectedYear}
              onChange={e => setSelectedYear(e.target.value)}
            >
              {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {activeTab === 'calculator' ? (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="button outline" style={{ backgroundColor: 'white' }} onClick={() => handlePrint('overview')} disabled={distributions.length === 0}>
                🖨️ Gesamt
              </button>
              <button className="button" onClick={() => handlePrint('depots')} disabled={distributions.length === 0}>
                🖨️ Depots
              </button>
            </div>
          ) : (
            <div style={{ width: '200px' }}></div>
          )}
        </div>
      </header>

      {activeTab === 'calculator' && (
        <div className="calculator-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 350px) 1fr', gap: '2rem' }}>

          {/* Sidebar / Form */}
          <div>
            <div className="glass-panel" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
              <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>🌱 Neue Ernte eintragen</h2>
              <div className="form-group">
                <label>Artikel auswählen</label>
                <select
                  className="input"
                  value={selectedArticle}
                  onChange={e => setSelectedArticle(e.target.value)}
                >
                  {[...editableArticles].sort((a, b) => a.name.localeCompare(b.name, 'de-DE')).map(a => (
                    <option key={`${a.name}-${a.unit}`} value={getArticleSelectionKey(a)}>{a.name} ({a.unit})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Gesamtmenge</label>
                <input
                  type="number"
                  className="input"
                  placeholder="z.B. 150"
                  value={amount}
                  min="0"
                  step="any"
                  onChange={e => setAmount(Number(e.target.value) || '')}
                  onKeyDown={e => e.key === 'Enter' && handleAddHarvest()}
                />
              </div>

              <button className="button" style={{ width: '100%', marginTop: '0.5rem' }} onClick={handleAddHarvest}>
                ＋ Zur Verteilung hinzufügen
              </button>
            </div>
          </div>

          {/* Main Area / Distributions */}
          <div>
            {distributions.length === 0 && (
              <div className="glass-panel" style={{ padding: '4rem', textAlign: 'center', color: 'var(--color-text)' }}>
                <h3>🌾 Noch keine Artikel hinzugefügt</h3>
                <p style={{ color: 'var(--color-text-light)' }}>Wähle links einen Artikel und eine Menge, um die Verteilung zu berechnen.</p>
              </div>
            )}

            {distributions.map((dist, idx) => {
              const remainderAllocation = getRemainderAllocation(dist);

              return (
                <div key={dist.id} className="glass-panel animate-in" style={{ padding: '1.5rem', marginBottom: '1.5rem', animationDelay: `${idx * 0.1}s` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{ flex: '0 0 32%', maxWidth: '360px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <h3 style={{ fontSize: '1.2rem', margin: 0 }}>{dist.articleName}</h3>

                        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-surface-solid)', borderRadius: '6px', border: '1px solid var(--color-border)', padding: '2px' }}>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={dist.totalHarvested}
                            onChange={(e) => handleUpdateAmount(dist.id, Number(e.target.value))}
                            style={{ width: '80px', border: 'none', background: 'transparent', textAlign: 'right', outline: 'none', fontWeight: 600, color: 'var(--color-primary)', fontSize: '0.95rem' }}
                          />
                          <span style={{ fontSize: '0.85rem', color: 'var(--color-text-light)', padding: '0 8px 0 4px', fontWeight: 500 }}>{dist.unit}</span>
                        </div>

                        {dist.excludedDepots && dist.excludedDepots.length > 0 && (
                          <span className="badge" style={{ background: 'rgba(225, 29, 72, 0.1)', color: 'var(--color-danger)' }}>
                            {dist.excludedDepots.length} ausgeschlossen
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: '0.95rem', color: 'var(--color-text-light)' }}>
                        Rechnerisch entspricht ein <strong style={{ color: 'var(--color-primary)' }}>halber Anteil ca. {dist.unit === 'kg' ? `${Math.round(dist.sharePerHalb * 1000).toLocaleString('de-DE')} g` : `${dist.sharePerHalb} ${dist.unit}`}</strong>.
                      </span>
                      {dist.unit === 'Stück' && dist.sharePerHalb < 1 && (
                        <div style={{ background: 'rgba(225, 29, 72, 0.1)', color: 'var(--color-danger)', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid var(--color-danger)', fontSize: '0.85rem', marginTop: '0.55rem' }}>
                          ⚠️ <strong>Achtung:</strong> Die Menge reicht nicht für mindestens 1 Stück pro Person. Bitte Depots ausschließen!
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'end', gap: '0.75rem', flex: '1 1 68%', minWidth: 0 }}>
                      {dist.remainder > 0 && (
                        <div style={{ background: 'var(--color-surface-solid)', padding: '0.75rem', borderRadius: '8px', border: '1px solid rgba(225, 29, 72, 0.2)', flex: '1 1 auto', minWidth: 0 }}>
                          <div style={{ fontWeight: 500, color: 'var(--color-danger)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                            📦 Rest: {dist.remainder} {dist.unit} übrig
                          </div>
                          {dist.unit === 'Stück' ? (
                            <div style={{ fontSize: '0.85rem', color: 'var(--color-text-light)' }}>
                              Wähle unten Depots aus, auf die der Rest gleichmäßig verteilt wird (in vollen halben-Anteil-Runden).
                              <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  className="button"
                                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}
                                  onClick={() => handleSelectAllGeschenkDepots(dist.id)}
                                >
                                  ✓ Alle auswählen
                                </button>
                                <button
                                  type="button"
                                  className="button"
                                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}
                                  onClick={() => handleClearGeschenkDepots(dist.id)}
                                >
                                  ✕ Auswahl aufheben
                                </button>
                              </div>
                              <div style={{ marginTop: '0.35rem' }}>
                                Verteilt: <strong>{remainderAllocation.distributedAmount} {dist.unit}</strong>
                                {remainderAllocation.openRemainder > 0 && (
                                  <span style={{ color: 'var(--color-danger)', marginLeft: '0.5rem' }}>
                                    (nicht verteilbar: {remainderAllocation.openRemainder} {dist.unit})
                                  </span>
                                )}
                              </div>
                              <div style={{ marginTop: '0.25rem' }}>
                                Zusatz pro halbem Anteil (aktuelle Auswahl): <strong>+{remainderAllocation.rounds} Stück</strong>
                              </div>
                              {dist.geschenkeDepotKuerzel.length > 0 && remainderAllocation.rounds === 0 && (
                                <div style={{ marginTop: '0.35rem', color: 'var(--color-danger)' }}>
                                  ⚠️ Keine volle Runde möglich – wähle weniger oder andere Depots.
                                </div>
                              )}
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.85rem', color: 'var(--color-text-light)' }}>
                              kg-Produkte werden restlos verteilt – hier ist keine Resteverteilung nötig.
                            </div>
                          )}
                        </div>
                      )}

                      <button
                        onClick={() => handleDeleteDistribution(dist.id)}
                        title="Artikel aus Verteilung entfernen"
                        style={{ width: '76px', background: 'transparent', border: '1px solid transparent', cursor: 'pointer', fontSize: '0.85rem', padding: '0.35rem 0.5rem', borderRadius: '6px', opacity: 0.5, transition: 'var(--transition)', color: 'var(--color-danger)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = 'var(--color-danger)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.borderColor = 'transparent'; }}
                      >
                        ✕ Entfernen
                      </button>
                    </div>
                  </div>

                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Aktiv</th>
                          <th>Depot</th>
                          {dist.unit === 'kg' ? (
                            <>
                              <th>Brutto (kg)</th>
                              <th>Netto (kg)</th>
                            </>
                          ) : (
                            <th>St. pro ½ Anteil</th>
                          )}
                          {dist.unit === 'Stück' && dist.remainder > 0 && <th>Rest zuteilen</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {dist.results.map(res => {
                          const matchedDepot = editableDepots.find(d => d.kuerzel === res.depotKuerzel);
                          const ratioState = fairnessByArticle[dist.articleName]?.[res.depotKuerzel];
                          let indicator = null;
                          if (ratioState === 'wenig') indicator = <span title="Letzte 12 Monate: Deutlich weniger als Durchschnitt erhalten (Nachholbedarf)" style={{ marginLeft: '0.5rem', cursor: 'help' }}>🔴🔻</span>;
                          if (ratioState === 'viel') indicator = <span title="Letzte 12 Monate: Deutlich mehr als Durchschnitt erhalten" style={{ marginLeft: '0.5rem', cursor: 'help' }}>🟢🔺</span>;

                          return (
                            <tr key={res.depotKuerzel} style={{ opacity: res.isExcluded ? 0.5 : 1, background: res.isExcluded ? 'rgba(0,0,0,0.02)' : 'transparent', transition: 'var(--transition)' }}>
                              <td style={{ width: '60px', textAlign: 'center' }}>
                                <input
                                  type="checkbox"
                                  title="Wenn deaktiviert, erhält dieses Depot keinen Anteil von diesem Artikel."
                                  checked={!res.isExcluded}
                                  onChange={() => handleToggleExclusion(dist.id, res.depotKuerzel)}
                                  style={{ cursor: 'pointer', transform: 'scale(1.2)', accentColor: 'var(--color-primary)' }}
                                />
                              </td>
                              <td>
                                {res.depotKuerzel} {indicator}
                                <span style={{ marginLeft: '0.5rem', color: 'var(--color-text-light)', fontSize: '0.85rem' }}>
                                  ({matchedDepot?.gesamtHalbeAnteile} halbe Ant.)
                                </span>
                                {res.isExcluded && <i style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-danger)' }}>(ausgeschl.)</i>}
                              </td>
                              {dist.unit === 'kg' ? (
                                <>
                                  <td style={{ fontWeight: res.isExcluded ? 400 : 600 }}>
                                    {res.isExcluded
                                      ? '-'
                                      : round2(res.calculatedAmount + (remainderAllocation.allocationsByDepot[res.depotKuerzel] || 0)).toFixed(2)}
                                  </td>
                                  <td style={{ fontWeight: res.isExcluded ? 400 : 600 }}>
                                    {res.isExcluded
                                      ? '-'
                                      : toNetKg(round2(res.calculatedAmount + (remainderAllocation.allocationsByDepot[res.depotKuerzel] || 0))).toFixed(2)}
                                  </td>
                                </>
                              ) : (
                                <td style={{ fontWeight: res.isExcluded ? 400 : 600 }}>
                                  {res.isExcluded
                                    ? '-'
                                    : (() => {
                                      const totalForDepot = round2(res.calculatedAmount + (remainderAllocation.allocationsByDepot[res.depotKuerzel] || 0));
                                      const halbeAnteile = matchedDepot?.gesamtHalbeAnteile ?? 1;
                                      const perHalb = halbeAnteile > 0 ? Math.round(totalForDepot / halbeAnteile) : 0;
                                      return perHalb.toString();
                                    })()}
                                </td>
                              )}
                              {dist.unit === 'Stück' && dist.remainder > 0 && (
                                <td style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
                                  {!res.isExcluded && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={dist.geschenkeDepotKuerzel.includes(res.depotKuerzel)}
                                        onChange={e => handleSelectGeschenk(dist.id, res.depotKuerzel, e.target.checked)}
                                        style={{ cursor: 'pointer', accentColor: 'var(--color-danger)' }}
                                      />
                                      <span>
                                        {remainderAllocation.allocationsByDepot[res.depotKuerzel]
                                          ? `+ ${remainderAllocation.allocationsByDepot[res.depotKuerzel]}`
                                          : ''}
                                      </span>
                                    </label>
                                  )}
                                  {res.isExcluded && '-'}
                                </td>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <HistoryView
          data={historyData}
          selectedYear={selectedYear}
          onHistoryChange={setHistoryData}
          onBackupHistory={handleBackupHistory}
          onImportHistory={handleImportHistory}
          allDepots={[
            ...editableDepots,
            // Include historic depots from data.ts for backward compatibility with old history entries
            ...ALL_DEPOTS.filter(d => d.isHistoric && !editableDepots.find(e => e.kuerzel === d.kuerzel))
          ]}
        />
      )}

      {activeTab === 'masterdata' && (
        <MasterDataView
          articles={editableArticles}
          depots={editableDepots}
          onArticlesChange={setEditableArticles}
          onDepotsChange={setEditableDepots}
        />
      )}
    </div>
  );
}

export default App;
