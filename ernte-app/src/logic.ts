import { Depot, UnitType } from './data';

export type DistributionMode = 'halbeAnteile' | 'mitglieder';

export interface DistributionResult {
  depotKuerzel: string;
  calculatedAmount: number; // Base calculated (floor for pcs, exact for kg)
  isExcluded: boolean;      // True if the depot was excluded from this distribution
}

export interface Distribution {
  id: string;               // Unique ID for UI handling
  articleName: string;
  unit: UnitType;
  totalHarvested: number;
  results: DistributionResult[];
  remainder: number;        // Unallocated remainder (pieces)
  excludedDepots: string[];
  geschenkeDepotKuerzel: string[]; // Depots selected for remainder distribution
  sharePerHalb: number;     // Amount per half-share (halbeAnteile mode) or per member (mitglieder mode)
  distributionMode: DistributionMode;
}

export interface PieceRemainderAllocation {
  allocationsByDepot: Record<string, number>;
  distributedAmount: number;
  openRemainder: number;
  rounds: number;
}

/**
 * Returns the number of members (Mitglieder) for a depot:
 * half-share holders + full-share holders.
 */
function depotMitglieder(depot: Depot): number {
  return depot.halbeAnteile + depot.ganzeAnteile;
}

/**
 * Distributes an article based on the rules, excluding specific depots.
 * Depots list is passed explicitly so editable stammdaten are used.
 */
export function calculateDistribution(
  articleName: string,
  unit: UnitType,
  amount: number,
  excludedDepots: string[] = [],
  depots: Depot[],
  mode: DistributionMode = 'halbeAnteile'
): Distribution {
  let results: DistributionResult[] = [];
  let allocated = 0;

  const includedDepots = depots.filter(d => !excludedDepots.includes(d.kuerzel));

  // Choose the weight function based on the distribution mode
  const getWeight = (d: Depot) => mode === 'mitglieder' ? depotMitglieder(d) : d.gesamtHalbeAnteile;
  const effectiveTotal = includedDepots.reduce((sum, d) => sum + getWeight(d), 0);

  let sharePerHalb = 0;
  if (effectiveTotal > 0) {
    if (unit === 'Stück') {
      sharePerHalb = Math.floor(amount / effectiveTotal);
    } else {
      sharePerHalb = Math.round((amount / effectiveTotal) * 100) / 100;
    }
  }

  for (const depot of depots) {
    const isExcluded = excludedDepots.includes(depot.kuerzel);
    let calculatedAmount = 0;

    if (!isExcluded && effectiveTotal > 0) {
      const weight = getWeight(depot);
      if (unit === 'Stück') {
        calculatedAmount = sharePerHalb * weight;
      } else {
        const exact = amount * (weight / effectiveTotal);
        calculatedAmount = Math.round(exact * 100) / 100;
      }
      allocated += calculatedAmount;
    }

    results.push({
      depotKuerzel: depot.kuerzel,
      calculatedAmount,
      isExcluded
    });
  }

  // Calculate remainder
  let remainder = 0;
  if (unit === 'Stück') {
    remainder = amount - allocated;
  } else {
    // kg wird restlos verteilt – Rundungsdifferenz geht ans letzte inkludierte Depot
    const roundingError = Math.round((amount - allocated) * 100) / 100;
    if (Math.abs(roundingError) >= 0.01 && includedDepots.length > 0) {
      const lastIncluded = includedDepots[includedDepots.length - 1];
      const lastResult = results.find(r => r.depotKuerzel === lastIncluded.kuerzel);
      if (lastResult) {
        lastResult.calculatedAmount = Math.round((lastResult.calculatedAmount + roundingError) * 100) / 100;
      }
    }
    remainder = 0;
  }

  return {
    id: Math.random().toString(36).substr(2, 9),
    articleName,
    unit,
    totalHarvested: amount,
    results,
    remainder,
    excludedDepots,
    geschenkeDepotKuerzel: [],
    sharePerHalb,
    distributionMode: mode
  };
}

/**
 * Distributes piece remainders in full "rounds" across selected depots.
 * In halbeAnteile mode: one round = each depot gets its gesamtHalbeAnteile pieces.
 * In mitglieder mode: one round = each depot gets its member count (halbeAnteile + ganzeAnteile) pieces.
 */
export function calculatePieceRemainderAllocation(
  remainder: number,
  selectedDepotKuerzel: string[],
  excludedDepots: string[],
  depots: Depot[],
  mode: DistributionMode = 'halbeAnteile'
): PieceRemainderAllocation {
  if (remainder <= 0 || selectedDepotKuerzel.length === 0) {
    return {
      allocationsByDepot: {},
      distributedAmount: 0,
      openRemainder: remainder,
      rounds: 0
    };
  }

  const seen = new Set<string>();
  const selectedDepots = selectedDepotKuerzel
    .filter(kuerzel => {
      if (seen.has(kuerzel)) return false;
      seen.add(kuerzel);
      return true;
    })
    .map(kuerzel => depots.find(d => d.kuerzel === kuerzel))
    .filter((depot): depot is Depot => !!depot)
    .filter(depot => {
      if (excludedDepots.includes(depot.kuerzel)) return false;
      return mode === 'mitglieder'
        ? depotMitglieder(depot) > 0
        : depot.gesamtHalbeAnteile > 0;
    });

  const getWeight = (d: Depot) => mode === 'mitglieder' ? depotMitglieder(d) : d.gesamtHalbeAnteile;
  const totalWeight = selectedDepots.reduce((sum, depot) => sum + getWeight(depot), 0);

  if (totalWeight <= 0) {
    return {
      allocationsByDepot: {},
      distributedAmount: 0,
      openRemainder: remainder,
      rounds: 0
    };
  }

  const rounds = Math.floor(remainder / totalWeight);
  if (rounds <= 0) {
    return {
      allocationsByDepot: {},
      distributedAmount: 0,
      openRemainder: remainder,
      rounds: 0
    };
  }

  const allocationsByDepot: Record<string, number> = {};
  let distributedAmount = 0;

  for (const depot of selectedDepots) {
    const amountForDepot = rounds * getWeight(depot);
    allocationsByDepot[depot.kuerzel] = amountForDepot;
    distributedAmount += amountForDepot;
  }

  return {
    allocationsByDepot,
    distributedAmount,
    openRemainder: remainder - distributedAmount,
    rounds
  };
}

export function parseDate(dateStr: string): number {
  if (!dateStr) return 0;
  // format DD.MM.YY or DD.MM.YYYY -> convert to time for sorting
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    const d = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    let y = parseInt(parts[2], 10);
    if (y < 100) y += 2000;
    return new Date(y, m, d).getTime();
  }
  return 0;
}

export function getFairnessRatio(artikel: string, historieData: any[], depots: Depot[]): Record<string, 'viel' | 'wenig' | 'normal'> {
    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ONE_YEAR_MS;

    const depotSums = new Map<string, number>();

    const rows = historieData.filter(d => d.artikel === artikel && parseDate(d.datum) >= cutoff);
    if (rows.length === 0) return {}; 

    for (const r of rows) {
        let matched = depots.find(d => d.name === r.depot || d.kuerzel === r.depot);
        if (!matched) matched = depots.find(d => d.name.toLowerCase() === r.depot.toLowerCase());
        if (!matched) continue;

        let val = typeof r.halberAnteil === 'number' ? r.halberAnteil : 0;
        depotSums.set(matched.kuerzel, (depotSums.get(matched.kuerzel) || 0) + val);
    }

    if (depotSums.size === 0) return {};

    let totalSum = 0;
    let activeDepotsCount = 0;

    for (const d of depots) {
        let s = depotSums.get(d.kuerzel) || 0;
        totalSum += s;
        activeDepotsCount++;
    }

    const avg = totalSum / activeDepotsCount;
    if (avg === 0) return {};

    const result: Record<string, 'viel' | 'wenig' | 'normal'> = {};
    for (const d of depots) {
        let s = depotSums.get(d.kuerzel) || 0;
        let ratio = s / avg;
        if (ratio < 0.85) result[d.kuerzel] = 'wenig';
        else if (ratio > 1.15) result[d.kuerzel] = 'viel';
        else result[d.kuerzel] = 'normal';
    }
    return result;
}

/**
 * Determines the harvest year for a given date string (DD.MM.YYYY).
 * A harvest year starts on April 1st.
 */
export function getHarvestYear(dateStr: string): string {
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    const m = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    const yearNum = y < 100 ? y + 2000 : y;
    const harvestYear = (m < 4) ? yearNum - 1 : yearNum;
    return harvestYear.toString();
  }
  // Fallback to current harvest year
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  return (m < 4 ? y - 1 : y).toString();
}

/**
 * Reconstructs Distribution objects from today's history rows.
 * Used to restore the current distribution state on app startup when
 * history entries for the current day already exist.
 *
 * Results are built directly from the stored amounts so that per-depot
 * values — including any Geschenke (remainder) allocations that were
 * already applied — are preserved exactly. For kg, history stores net
 * amounts (×0.95); calculatedAmount is reversed to gross so the UI can
 * re-apply the net conversion consistently.
 */
export function reconstructDistributionsFromHistory(todayRows: any[], depots: Depot[]): Distribution[] {
  const articleMap = new Map<string, any[]>();
  for (const row of todayRows) {
    const unit: UnitType = (row.einheit === 'kg' || row.einheit === 'g') ? 'kg' : 'Stück';
    const key = `${row.artikel}__${unit}`;
    if (!articleMap.has(key)) articleMap.set(key, []);
    articleMap.get(key)!.push({ ...row, _resolvedUnit: unit });
  }

  const result: Distribution[] = [];

  for (const [, rows] of articleMap) {
    const articleName: string = rows[0].artikel;
    const unit: UnitType = rows[0]._resolvedUnit;

    // Index history rows by depot name for fast lookup
    const rowByDepot = new Map<string, any>();
    for (const row of rows) {
      rowByDepot.set(row.depot, row);
    }

    // A depot is considered included when it has a positive history entry
    const includedKuerzel = new Set<string>();
    for (const depot of depots) {
      const histRow = rowByDepot.get(depot.name) ?? rowByDepot.get(depot.kuerzel);
      if (histRow && Number(histRow.gesamtMenge) > 0) {
        includedKuerzel.add(depot.kuerzel);
      }
    }

    const excludedDepots = depots
      .filter(d => !includedKuerzel.has(d.kuerzel))
      .map(d => d.kuerzel);

    // Build DistributionResult entries directly from history amounts.
    // For kg: history stores net (gesamtMenge = gross × 0.95); reverse to gross
    // so the UI can apply toNetKg() again consistently.
    let totalHarvested = 0;
    const results: DistributionResult[] = depots.map(depot => {
      const isExcluded = !includedKuerzel.has(depot.kuerzel);
      if (isExcluded) {
        return { depotKuerzel: depot.kuerzel, calculatedAmount: 0, isExcluded: true };
      }
      const histRow = rowByDepot.get(depot.name) ?? rowByDepot.get(depot.kuerzel);
      const net = Number(histRow?.gesamtMenge) || 0;
      const calculatedAmount = unit === 'kg'
        ? Math.round((net / 0.95) * 100) / 100
        : net;
      totalHarvested += calculatedAmount;
      return { depotKuerzel: depot.kuerzel, calculatedAmount, isExcluded: false };
    });

    // Recompute sharePerHalb from the reconstructed totals for display
    const effectiveTotalAnteile = depots
      .filter(d => includedKuerzel.has(d.kuerzel))
      .reduce((s, d) => s + d.gesamtHalbeAnteile, 0);
    let sharePerHalb = 0;
    if (effectiveTotalAnteile > 0) {
      sharePerHalb = unit === 'Stück'
        ? Math.floor(totalHarvested / effectiveTotalAnteile)
        : Math.round((totalHarvested / effectiveTotalAnteile) * 100) / 100;
    }

    result.push({
      id: Math.random().toString(36).substr(2, 9),
      articleName,
      unit,
      totalHarvested,
      results,
      remainder: 0,
      excludedDepots,
      geschenkeDepotKuerzel: [],
      sharePerHalb,
      distributionMode: 'halbeAnteile'
    });
  }

  return result;
}

/**
 * Converts history data to CSV format.
 */
export function convertToCSV(data: any[]): string {
  if (data.length === 0) return "";
  const headers = ["Datum", "Depot", "Artikel", "GesamtMenge", "Ganze Anteile", "Halbe Anteile", "Einheit"];
  const keys = ["datum", "depot", "artikel", "gesamtMenge", "ganzerAnteil", "halberAnteil", "einheit"];
  
  const rows = data.map(obj => 
    keys.map(key => {
      let val = obj[key] ?? "";
      
      // Handle decimals for German Excel (replace . with ,)
      if (typeof val === 'number') {
        val = val.toString().replace('.', ',');
      } else if (typeof val === 'string') {
        if (val.includes(';') || val.includes('"') || val.includes('\n')) {
          val = `"${val.replace(/"/g, '""')}"`;
        }
      }
      return val;
    }).join(';')
  );
  return [headers.join(';'), ...rows].join('\n');
}

/**
 * Parses CSV format back to history data.
 */
export function parseCSV(csv: string): any[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim() !== "");
  if (lines.length < 2) return [];
  
  const parseLine = (line: string) => {
    const result = [];
    let cur = "";
    let inQuotes = false;
    // Support both comma and semicolon
    const separator = line.includes(';') && !line.includes(',') ? ';' : ',';
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i+1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === separator && !inQuotes) {
        result.push(cur);
        cur = "";
      } else {
        cur += char;
      }
    }
    result.push(cur);
    return result;
  };

  const headers = parseLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = parseLine(line);
    const obj: any = {};
    headers.forEach((header, i) => {
      let val: any = values[i]?.trim();
      if (val === undefined) val = "";
      
      // Convert specific fields to numbers
      if (["gesamtMenge", "ganzerAnteil", "halberAnteil"].includes(header)) {
         const num = Number(val.replace(',', '.'));
         val = isNaN(num) ? 0 : num;
      }
      obj[header] = val;
    });
    return obj;
  });
}
