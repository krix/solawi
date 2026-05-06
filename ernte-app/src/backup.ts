import { invoke } from '@tauri-apps/api/core';

/**
 * Funktion zum Sichern der aktuellen Historie-Dateien als Backup.
 * Erstellt eine Kopie der JSON-Dateien mit einem Zeitstempel im Dateinamen.
 */
export async function backupHistoryFiles(): Promise<boolean> {
  try {
    // Liste aller verfügbaren Historie-Jahre abrufen
    const years = await invoke<string[]>('list_history_years');

    // Für jedes Jahr ein Backup erstellen
    for (const year of years) {
      // Historie für das Jahr laden
      const historyJson = await invoke<string>('load_history', { year });

      // Backup erstellen
      const backupFileName = `historie-${year}.json`;

      // Backup speichern
      await invoke('save_backup_file', {
        content: historyJson,
        fileName: backupFileName
      });
    }

    return true;
  } catch (error) {
    console.error('Fehler beim Erstellen des Backups:', error);
    return false;
  }
}

/**
 * Funktion zum Importieren einer oder mehrerer Historie-JSON-Dateien.
 * @param files Datei-Array mit den zu importierenden JSON-Dateien
 * @param mergeIfExists Wenn true, werden vorhandene Einträge mit den neuen kombiniert
 */
export async function importHistoryFiles(files: File[], mergeIfExists: boolean = true): Promise<boolean> {
  try {
    for (const file of files) {
      // Dateiinhalt lesen
      const content = await readFileAsText(file);

      // JSON parsen
      let importedData: any[];
      try {
        importedData = JSON.parse(content);
      } catch (parseError) {
        console.error(`Fehler beim Parsen der Datei ${file.name}:`, parseError);
        throw new Error(`Ungültiges JSON-Format in Datei ${file.name}`);
      }

      // Jahr aus dem Dateinamen extrahieren (z.B. "historie-2024.json")
      const yearMatch = file.name.match(/historie-(\d{4})\.json/);
      if (!yearMatch) {
        throw new Error(`Ungültiger Dateiname: ${file.name}. Erwartet wird das Format 'historie-YYYY.json'`);
      }

      const year = yearMatch[1];

      // Prüfen, ob bereits Daten für dieses Jahr existieren
      let existingData: any[] = [];
      try {
        const existingJson = await invoke<string>('load_history', { year });
        existingData = JSON.parse(existingJson);
      } catch (loadError) {
        // Keine vorhandenen Daten für dieses Jahr, das ist okay
        existingData = [];
      }

      // Daten zusammenführen oder ersetzen
      let finalData: any[];
      if (mergeIfExists && existingData.length > 0) {
        // Kombinieren der existierenden und importierten Daten
        // Dabei werden Duplikate entfernt (basierend auf Datum, Depot und Artikel)
        const combined = [...existingData];
        const existingKeys = new Set(existingData.map(item =>
          `${item.datum}-${item.depot}-${item.artikel}`
        ));

        for (const newItem of importedData) {
          const key = `${newItem.datum}-${newItem.depot}-${newItem.artikel}`;
          if (!existingKeys.has(key)) {
            combined.push(newItem);
          }
        }
        finalData = combined;
      } else {
        // Importierte Daten ersetzen die vorhandenen
        finalData = importedData;
      }

      // Daten als String serialisieren
      const jsonContent = JSON.stringify(finalData, null, 2);

      // Daten speichern
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