import { invoke } from '@tauri-apps/api/core';

/**
 * Funktion zum Exportieren der Historie eines bestimmten Erntejahres.
 * @param year Das zu exportierende Erntejahr
 */
export async function backupHistoryFiles(year: string): Promise<boolean> {
  try {
    const historyJson = await invoke<string>('load_history', { year });
    const backupFileName = `historie-${year}.json`;
    await invoke('save_backup_file', {
      content: historyJson,
      fileName: backupFileName
    });
    return true;
  } catch (error) {
    console.error('Fehler beim Erstellen des Backups:', error);
    return false;
  }
}

/**
 * Funktion zum Importieren einer oder mehrerer Historie-JSON-Dateien.
 * Die importierten Daten überschreiben vorhandene Einträge für das jeweilige Jahr.
 * @param files Datei-Array mit den zu importierenden JSON-Dateien
 */
export async function importHistoryFiles(files: File[]): Promise<boolean> {
  try {
    for (const file of files) {
      const content = await readFileAsText(file);

      let importedData: any[];
      try {
        importedData = JSON.parse(content);
      } catch (parseError) {
        console.error(`Fehler beim Parsen der Datei ${file.name}:`, parseError);
        throw new Error(`Ungültiges JSON-Format in Datei ${file.name}`);
      }

      const yearMatch = file.name.match(/historie-(\d{4})\.json/);
      if (!yearMatch) {
        throw new Error(`Ungültiger Dateiname: ${file.name}. Erwartet wird das Format 'historie-YYYY.json'`);
      }

      const year = yearMatch[1];
      const jsonContent = JSON.stringify(importedData, null, 2);
      await invoke('sync_history', { year, jsonContent });
    }

    return true;
  } catch (error) {
    console.error('Fehler beim Importieren der Historie-Dateien:', error);
    return false;
  }
}

// Hilfsfunktion zum Lesen von Dateiinhalten
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}