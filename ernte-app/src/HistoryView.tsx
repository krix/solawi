import { useState, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { Depot } from './data';
import { parseDate, convertToCSV, parseCSV } from './logic';

interface DepotStat {
  kgSum: number;
  stkSum: number;
  kgFairSum: number;
  stkFairSum: number;
}

interface HistoryViewProps {
  data: any[];
  selectedYear: string;
  onHistoryChange?: (newData: any[]) => void;
  onBackupHistory?: () => void;
  onImportHistory?: (files: FileList | null) => void;
}

export default function HistoryView({ data, selectedYear, onHistoryChange, onBackupHistory, onImportHistory }: HistoryViewProps) {
  const [filterArticle, setFilterArticle] = useState<string>('Alle');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [printingSpecific, setPrintingSpecific] = useState<'depots' | 'harvest' | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleDateInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
    setter: (value: string) => void
  ) => {
    setter(event.target.value);
    // WebKit/Linux date picker can stay open after selection; blur closes it reliably.
    setTimeout(() => event.target.blur(), 0);
  };

  const handleDateInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.currentTarget.blur();
    }
  };

  const saveHistory = async (year: string, updatedHistory: any[]) => {
    const jsonContent = JSON.stringify(updatedHistory, null, 2);
    try {
      await invoke('sync_history', { year, jsonContent });
    } catch (e) {
      console.error("Failed to save history:", e);
      alert("Fehler beim Speichern der Historie.");
    }
  };

  const handleExportCSV = async () => {
    const csv = convertToCSV(data);
    const fileName = `historie-${selectedYear}.csv`;
    try {
      await invoke('save_csv_file', { content: csv, defaultName: fileName });
    } catch (e) {
      console.error("Failed to export CSV:", e);
      alert("Fehler beim CSV Export.");
    }
  };

  const handleExportDepotStats = async () => {
    const headers = ["Depot", "Basis Halbe Anteile", "kg Gesamt", "kg pro Halber Anteil", "Stk Gesamt", "Stk pro Halber Anteil"];
    const rows = stats.map(s => [
      s.depot,
      s.gesamtHalbeAnteile,
      s.kgSum.toFixed(2).replace('.', ','),
      s.kgFairSum.toFixed(2).replace('.', ','),
      s.stkSum.toFixed(0),
      s.stkFairSum.toFixed(2).replace('.', ',')
    ].join(';'));
    const csv = [headers.join(';'), ...rows].join('\n');
    await invoke('save_csv_file', { content: csv, defaultName: `Depot-Statistik-${selectedYear}.csv` });
  };

  const handleExportHarvestStats = async () => {
    const headers = ["Gemüsesorte", "Erntemenge Brutto", "Erntemenge Netto", "Stück"];
    const rows = harvestStats.map(h => [
      h.artikel,
      h.kgSumBrutto.toFixed(2).replace('.', ','),
      h.kgSumNetto.toFixed(2).replace('.', ','),
      h.stkSum.toFixed(0)
    ].join(';'));
    const csv = [headers.join(';'), ...rows].join('\n');
    await invoke('save_csv_file', { content: csv, defaultName: `Gesamternte-${selectedYear}.csv` });
  };

  const handlePrintSpecific = (type: 'depots' | 'harvest') => {
    setPrintingSpecific(type);
    setTimeout(() => {
      window.print();
      setPrintingSpecific(null);
    }, 100);
  };

  const handleImportCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const csv = event.target?.result as string;
      const imported = parseCSV(csv);
      if (imported.length > 0) {
        if (window.confirm(`${imported.length} Einträge in das Erntejahr ${selectedYear} importieren?`)) {
          const updated = [...data, ...imported];
          onHistoryChange?.(updated);
          await saveHistory(selectedYear, updated);
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleImportHistoryFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (onImportHistory) {
      onImportHistory(files);
    }
    // Reset input value to allow importing the same file again
    if (importInputRef.current) importInputRef.current.value = '';
  };

  const baseFilteredData = useMemo(() => {
    if (!startDate && !endDate) return data;

    let sTime = startDate ? new Date(startDate).getTime() : 0;
    let eTime = endDate ? new Date(endDate).getTime() : Infinity;
    if (endDate) eTime += 86400000 - 1; // inclusive end of day

    return data.filter(row => {
      const t = parseDate(row.datum);
      return t >= sTime && t <= eTime;
    });
  }, [startDate, endDate, data]);

  const uniqueArticles = useMemo(() => {
    const set = new Set<string>();
    for (const row of baseFilteredData) set.add(row.artikel);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'de-DE'));
  }, [baseFilteredData]);

  // Depots are derived exclusively from the history data (independent of current Stammdaten).
  // The number of half-shares per depot is determined from the most recent record:
  // gesamtMenge / halberAnteil = number of half-shares.
  const derivedDepots = useMemo<Depot[]>(() => {
    const depotNames = new Set<string>();
    for (const row of data) {
      if (row.depot) depotNames.add(row.depot);
    }

    return Array.from(depotNames).map(name => {
      // Pick the most recent row (by date) with valid values to compute the half-share count.
      let sample: any = null;
      let sampleTime = -Infinity;
      for (const r of data) {
        if (r.depot !== name || !(r.halberAnteil > 0) || !(r.gesamtMenge > 0)) continue;
        const t = parseDate(r.datum);
        if (t >= sampleTime) {
          sampleTime = t;
          sample = r;
        }
      }
      const gesamtHalbeAnteile = sample
        ? Math.round(sample.gesamtMenge / sample.halberAnteil)
        : 0;

      return {
        name,
        kuerzel: name,
        gesamtHalbeAnteile,
        halbeAnteile: 0,
        ganzeAnteile: 0,
        prozent: 0,
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'de-DE'));
  }, [data]);

  // Aggregation for the Table (Totals & Fairness)
  const stats = useMemo(() => {
    const map = new Map<string, DepotStat>();

    // Initialize map
    for (const d of derivedDepots) {
      map.set(d.name, { kgSum: 0, stkSum: 0, kgFairSum: 0, stkFairSum: 0 });
    }

    const filteredData = filterArticle === 'Alle'
      ? baseFilteredData
      : baseFilteredData.filter(d => d.artikel === filterArticle);

    for (const row of filteredData) {
      const { depot, gesamtMenge, halberAnteil, einheit } = row;
      let stat = map.get(depot);

      if (!stat) {
        stat = { kgSum: 0, stkSum: 0, kgFairSum: 0, stkFairSum: 0 };
        map.set(depot, stat);
      }

      if (einheit === 'g' || einheit === 'kg') {
        stat.kgSum += einheit === 'g' ? (gesamtMenge / 1000) : gesamtMenge;
        stat.kgFairSum += einheit === 'g' ? (halberAnteil / 1000) : halberAnteil;
      } else if (einheit.toLowerCase().includes('stück')) {
        stat.stkSum += gesamtMenge;
        stat.stkFairSum += halberAnteil;
      }
    }

    return derivedDepots.map(d => {
      const stat = map.get(d.name);

      return {
        depot: d.name,
        kuerzel: d.kuerzel,
        gesamtHalbeAnteile: d.gesamtHalbeAnteile,
        kgSum: stat?.kgSum || 0,
        stkSum: stat?.stkSum || 0,
        kgFairSum: stat?.kgFairSum || 0,
        stkFairSum: stat?.stkFairSum || 0
      };
    }).sort((a, b) => b.kgSum - a.kgSum);

  }, [filterArticle, baseFilteredData, derivedDepots]);

  // Aggregation for the Timeline Chart (Cumulative over time)
  const chartData = useMemo(() => {
    if (filterArticle === 'Alle') return [];

    const filtered = baseFilteredData.filter(d => d.artikel === filterArticle);

    // Build map: Date -> { DateString, deliveries: {} }
    const dateMap = new Map<string, any>();

    for (const row of filtered) {
      const { datum, depot, halberAnteil, einheit } = row;

      if (!derivedDepots.some(d => d.name === depot)) continue;

      let amountPerHalfShare = einheit === 'g' ? (halberAnteil / 1000) : halberAnteil;

      if (!dateMap.has(datum)) {
        dateMap.set(datum, { rawDate: datum, sortKey: parseDate(datum), deliveries: {} });
      }

      const record = dateMap.get(datum);
      // Accumulate if the same depot has multiple lines on the same day
      record.deliveries[depot] = (record.deliveries[depot] || 0) + amountPerHalfShare;
    }

    const sortedDates = Array.from(dateMap.values()).sort((a, b) => a.sortKey - b.sortKey);

    // Running totals base
    const runningTotals = {} as Record<string, number>;
    derivedDepots.forEach(d => runningTotals[d.name] = 0);

    return sortedDates.map(d => {
      // Add today's deliveries to running totals
      for (const depotName of Object.keys(d.deliveries)) {
        runningTotals[depotName] += d.deliveries[depotName];
      }

      // Use full date as X key to avoid duplicate labels/clipping artifacts.
      const dataPoint: any = { datum: d.rawDate };
      derivedDepots.forEach(dep => {
        dataPoint[dep.name] = runningTotals[dep.name];
      });
      return dataPoint;
    });
  }, [filterArticle, baseFilteredData, derivedDepots]);

  const formatChartDateLabel = (value: string) => {
    if (!value || typeof value !== 'string') return value;
    const parts = value.split('.');
    if (parts.length !== 3) return value;
    const [day, month, year] = parts;
    return selectedYear === 'Alle' ? `${day}.${month}.${year.slice(-2)}` : `${day}.${month}`;
  };

  // Aggregation for Total Harvest table (+5% Schwund)
  const harvestStats = useMemo(() => {
    const map = new Map<string, { kgSum: number, stkSum: number }>();

    for (const row of baseFilteredData) {
      let { artikel, gesamtMenge, einheit } = row;

      if (!map.has(artikel)) map.set(artikel, { kgSum: 0, stkSum: 0 });
      const stat = map.get(artikel)!;

      if (einheit === 'g' || einheit === 'kg') {
        let kgVal = einheit === 'g' ? (gesamtMenge / 1000) : gesamtMenge;
        stat.kgSum += kgVal;
      } else if (einheit.toLowerCase().includes('stück')) {
        stat.stkSum += gesamtMenge;
      }
    }

    return Array.from(map.entries()).map(([artikel, data]) => {
      return {
        artikel,
        kgSumNetto: data.kgSum,
        kgSumBrutto: data.kgSum / 0.95, // Netto ÷ 0.95 = Brutto (da Werte bereits 5% Schwund enthalten)
        stkSum: data.stkSum
      };
    }).sort((a, b) => (b.kgSumBrutto + b.stkSum) - (a.kgSumBrutto + a.stkSum));
  }, [baseFilteredData]);

  return (
    <div className={`glass-panel animate-in ${printingSpecific ? 'no-panel-style' : ''}`} style={{ padding: printingSpecific ? '0' : '2rem', width: '100%', maxWidth: '1000px', margin: '0 auto', background: printingSpecific ? 'white' : '' }}>
      {printingSpecific && (
        <style>
          {`
            @media print {
              @page {
                size: A4 portrait;
                margin: 1cm;
              }
            }
          `}
        </style>
      )}

      <div className={printingSpecific ? 'no-print' : ''} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h2 style={{ color: 'var(--color-primary)', margin: 0 }}>
              Erweiterte Verteilungsstatistiken {selectedYear === 'Alle' ? '(Alle Jahre)' : `(${selectedYear})`}
            </h2>
          </div>
          <p style={{ color: 'var(--color-text-light)', fontSize: '0.9rem' }}>
            Auswertung von <strong>{baseFilteredData.length}</strong> historischen Daten.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.2rem' }}>
            <button className="button outline" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }} onClick={handleExportCSV}>
              📥 CSV Export
            </button>
            <button
              className="button outline"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', opacity: selectedYear === 'Alle' ? 0.5 : 1 }}
              onClick={() => {
                if (selectedYear === 'Alle') {
                  alert("Bitte wähle ein spezifisches Erntejahr aus, um Daten zu importieren.");
                } else {
                  fileInputRef.current?.click();
                }
              }}
              title={selectedYear === 'Alle' ? "Import nur in spezifischen Jahren möglich" : ""}
            >
              📤 CSV Import
            </button>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept=".csv"
              onChange={handleImportCSV}
            />
            <button
              className="button outline"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', opacity: selectedYear === 'Alle' ? 0.5 : 1 }}
              onClick={onBackupHistory}
              title={selectedYear === 'Alle' ? "Backup nur für spezifische Jahre möglich" : `Backup für ${selectedYear} erstellen`}
            >
              💾 Backup
            </button>
            <button
              className="button outline"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
              onClick={() => importInputRef.current?.click()}
            >
              🔁 Import
            </button>
            <input
              type="file"
              ref={importInputRef}
              style={{ display: 'none' }}
              accept=".json"
              onChange={handleImportHistoryFiles}
              multiple
            />
          </div>
        </div>

        <div className="history-date-filter-box" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'var(--color-surface-solid)', padding: '0.8rem', borderRadius: '8px', border: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'nowrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: '148px' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--color-text-light)', marginBottom: '0.2rem' }}>Von</label>
              <input
                type="date"
                className="input"
                style={{ padding: '0.2rem', fontSize: '0.9rem' }}
                value={startDate}
                onChange={e => handleDateInputChange(e, setStartDate)}
                onKeyDown={handleDateInputKeyDown}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: '148px' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--color-text-light)', marginBottom: '0.2rem' }}>Bis</label>
              <input
                type="date"
                className="input"
                style={{ padding: '0.2rem', fontSize: '0.9rem' }}
                value={endDate}
                onChange={e => handleDateInputChange(e, setEndDate)}
                onKeyDown={handleDateInputKeyDown}
              />
            </div>
          </div>
          {(startDate || endDate) && (
            <button
              type="button"
              className="button outline"
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', alignSelf: 'flex-end', whiteSpace: 'nowrap' }}
              onClick={() => { setStartDate(''); setEndDate(''); }}
            >
              🔄 Filter zurücksetzen
            </button>
          )}
        </div>
      </div>

      <div className={printingSpecific ? 'no-print' : ''} style={{ marginBottom: '1.4rem', paddingBottom: '1.2rem', borderBottom: '1px solid rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <label style={{ fontWeight: 500, color: 'var(--color-text)' }}>Verlauf / Fairness pro Artikel anzeigen:</label>
          <select
            className="input"
            style={{ minWidth: '200px' }}
            value={filterArticle}
            onChange={e => setFilterArticle(e.target.value)}
          >
            <option value="Alle">-- Nur Tabelle (Alle Artikel summiert) --</option>
            {uniqueArticles.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {filterArticle !== 'Alle' && chartData.length > 0 && (
          <div style={{ marginBottom: '1rem', height: '400px', width: '100%', background: 'var(--color-surface-solid)', padding: '1rem', borderRadius: '12px', border: '1px solid var(--color-border)' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '1rem', textAlign: 'center', color: 'var(--color-text)' }}>
              Kumulierter Fairness-Verlauf: {filterArticle} (Menge pro 1 Halbem Anteil)
            </h3>
            <p style={{ fontSize: '0.8rem', textAlign: 'center', color: 'var(--color-text-light)', marginBottom: '1rem' }}>
              Die Linien zeigen an, wie viel ein Anteil über die Zeit aufsummiert erhalten hat. Laufen die Linien parallel oder übereinander, war die Erntezeit extrem fair.
            </p>
            <ResponsiveContainer width="100%" height="80%">
              <LineChart data={chartData} margin={{ top: 5, right: 40, bottom: 5, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                <XAxis
                  dataKey="datum"
                  stroke="#888"
                  fontSize={12}
                  interval="preserveStartEnd"
                  minTickGap={20}
                  tickFormatter={formatChartDateLabel}
                  padding={{ left: 10, right: 20 }}
                />
                <YAxis stroke="#888" fontSize={12} domain={['auto', 'auto']} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Tooltip
                  contentStyle={{ borderRadius: '6px', border: 'none', boxShadow: '0 3px 10px rgba(0,0,0,0.12)', zIndex: 100, padding: '6px 8px', fontSize: '12px', lineHeight: 1.25 }}
                  wrapperStyle={{ zIndex: 100 }}
                  labelStyle={{ margin: 0, fontSize: '11px', color: '#6b7280' }}
                  itemStyle={{ padding: 0, margin: '1px 0' }}
                  formatter={(value: any) => typeof value === 'number' ? value.toFixed(2) : value}
                  labelFormatter={(label: any) => formatChartDateLabel(String(label))}
                />
                {derivedDepots.map((d, i) => (
                  <Line
                    key={d.name}
                    type="monotone"
                    dataKey={d.name}
                    stroke={`hsl(${i * (360 / derivedDepots.length)}, 70%, 50%)`}
                    strokeWidth={2}
                    isAnimationActive={false}
                    dot={{ r: 3 }}
                    activeDot={{ r: 6 }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {filterArticle !== 'Alle' && chartData.length === 0 && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-text-light)', background: 'rgba(0,0,0,0.02)', borderRadius: '8px', marginBottom: '2rem' }}>
            Keine chronologischen Daten für diesen Artikel in diesem Zeitraum vorhanden.
          </div>
        )}
      </div>

      {/* Depot-Lieferstatistik */}
      <div className={`table-container ${printingSpecific === 'harvest' ? 'no-print' : ''}`} style={{ border: printingSpecific === 'depots' ? 'none' : '' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(46, 165, 80, 0.05)', padding: '1rem' }}>
          <h3 style={{ fontSize: '1.2rem', color: 'var(--color-primary)', margin: 0 }}>Depot-Lieferstatistik (Netto)</h3>
          <div className="no-print" style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="button outline" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={() => handlePrintSpecific('depots')}>
              🖨️ Drucken
            </button>
            <button className="button outline" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={handleExportDepotStats}>
              📥 CSV
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Depot</th>
              <th style={{ textAlign: 'center' }}>Basis Halbe Anteile</th>
              <th style={{ textAlign: 'right' }}>Absolute gelieferte Menge</th>
              <th style={{ textAlign: 'right', background: 'rgba(46, 165, 80, 0.05)' }}>
                ⭐ Reelle Menge pro 1/2 Anteil
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.filter(s => s.kgSum > 0 || s.stkSum > 0 || filterArticle === 'Alle').map((s, i) => {
              const kgPerHalf = s.kgFairSum;
              const stkPerHalf = s.stkFairSum;

              return (
                <tr key={s.kuerzel}>
                  <td style={{ fontWeight: 500 }}>
                    <span style={{ marginRight: '0.5rem', color: '#999' }}>{i + 1}.</span>
                    {s.depot}
                  </td>
                  <td style={{ textAlign: 'center', color: 'var(--color-text-light)' }}>
                    {s.gesamtHalbeAnteile}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 500, color: 'var(--color-text)' }}>
                    {s.kgSum > 0 && <span>{s.kgSum.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg</span>}
                    {s.kgSum > 0 && s.stkSum > 0 && <span style={{ margin: '0 0.5rem' }}>|</span>}
                    {s.stkSum > 0 && <span>{s.stkSum.toLocaleString('de-DE')} Stück</span>}
                    {s.kgSum === 0 && s.stkSum === 0 && <span style={{ color: '#aaa' }}>-</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--color-primary)', background: 'rgba(46, 165, 80, 0.02)' }}>
                    {s.kgSum > 0 && <span>{(kgPerHalf).toLocaleString('de-DE', { maximumFractionDigits: 2 })} kg / 1/2 Anteil</span>}
                    {s.kgSum > 0 && s.stkSum > 0 && <br />}
                    {s.stkSum > 0 && <span>{(stkPerHalf).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Stk / 1/2 Anteil</span>}
                    {s.kgSum === 0 && s.stkSum === 0 && <span style={{ color: '#aaa' }}>-</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Gesamternte / Gemüsesorte */}
      <div className={`table-container ${printingSpecific === 'depots' ? 'no-print' : ''}`} style={{ border: printingSpecific === 'harvest' ? 'none' : '', marginTop: '1.6rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(46, 165, 80, 0.05)', padding: '1rem' }}>
          <h3 style={{ fontSize: '1.2rem', color: 'var(--color-primary)', margin: 0 }}>Gesamternte / Gemüsesorte (Brutto, inkl. 5% Schwund)</h3>
          <div className="no-print" style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="button outline" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={() => handlePrintSpecific('harvest')}>
              🖨️ Drucken
            </button>
            <button className="button outline" style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }} onClick={handleExportHarvestStats}>
              📥 CSV
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Gemüsesorte / Artikel</th>
              <th style={{ textAlign: 'right' }}>Errechnete Gesamternte (Brutto)</th>
              <th style={{ textAlign: 'right', color: 'var(--color-text-light)' }}>Gelieferte Übergabe (Netto)</th>
            </tr>
          </thead>
          <tbody>
            {harvestStats.length === 0 && (
              <tr><td colSpan={3} style={{ textAlign: 'center', padding: '2rem' }}>Keine Erntedaten in diesem Zeitraum gefunden.</td></tr>
            )}
            {harvestStats.map((h, i) => (
              <tr key={h.artikel}>
                <td style={{ fontWeight: 500 }}>
                  <span style={{ marginRight: '0.5rem', color: '#999' }}>{i + 1}.</span>
                  {h.artikel}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--color-primary)' }}>
                  {h.kgSumBrutto > 0 && <span>{h.kgSumBrutto.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg</span>}
                  {h.kgSumBrutto > 0 && h.stkSum > 0 && <span style={{ margin: '0 0.5rem' }}>|</span>}
                  {h.stkSum > 0 && <span>{h.stkSum.toLocaleString('de-DE')} Stück</span>}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--color-text-light)' }}>
                  {h.kgSumNetto > 0 && <span>{h.kgSumNetto.toLocaleString('de-DE', { maximumFractionDigits: 1 })} kg</span>}
                  {h.kgSumNetto > 0 && h.stkSum > 0 && <span style={{ margin: '0 0.5rem' }}>|</span>}
                  {h.stkSum > 0 && <span>{h.stkSum.toLocaleString('de-DE')} Stück</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
