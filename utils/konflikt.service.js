const mongoose = require('mongoose');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const KonfliktGruppe = require('../models/KonfliktGruppe');

/**
 * Synchronisiert die KonfliktGruppe-Collection mit dem aktuellen Stand der Konflikte.
 * Findet alle nicht-gelösten Konflikte, gruppiert sie nach beteiligten Anfragen
 * und erstellt oder aktualisiert die persistenten KonfliktGruppe-Dokumente.
 */
async function aktualisiereKonfliktGruppen() {
    console.log("Starte Synchronisation der Konfliktgruppen...");
    
    try {
        // 1. Lade ALLE Konfliktdokumente, um den gesamten "Soll-Zustand" zu erfassen.
        const relevanteKonflikte = await KonfliktDokumentation.find({}).select('beteiligteAnfragen');


        const gruppenMap = new Map();

        // 2. Gruppiere die Konflikte in-memory nach der exakten Zusammensetzung der beteiligten Anfragen
        for (const konflikt of relevanteKonflikte) {
            if (!konflikt.beteiligteAnfragen || konflikt.beteiligteAnfragen.length === 0) continue;
            
            const anfrageIdsStrings = konflikt.beteiligteAnfragen.map(a => a.toString()).sort();
            const gruppenSchluessel = anfrageIdsStrings.join('#');
            const konfliktStatus = konflikt.status;
            
            if (!gruppenMap.has(gruppenSchluessel)) {
                gruppenMap.set(gruppenSchluessel, {
                    beteiligteAnfragen: konflikt.beteiligteAnfragen,
                    konflikteInGruppe: [],
                    konfliktStatus: []
                });
            }
            gruppenMap.get(gruppenSchluessel).konflikteInGruppe.push(konflikt._id);
            gruppenMap.get(gruppenSchluessel).konfliktStatus.push(konfliktStatus);
        }

        // 3. Führe für jede gefundene Gruppe ein "Upsert" (Update or Insert) in der DB durch
        for (const [gruppenSchluessel, gruppe] of gruppenMap.entries()) {
            //hier zunächst den Status ermitteln aus dem array gruppenmap.konfliktStatus
            await KonfliktGruppe.findOneAndUpdate(
                { gruppenSchluessel: gruppenSchluessel }, // Finde Gruppe mit diesem eindeutigen Schlüssel
                { 
                    $set: { // Setze/Aktualisiere diese Felder immer
                        beteiligteAnfragen: gruppe.beteiligteAnfragen,
                        konflikteInGruppe: gruppe.konflikteInGruppe
                    },
                    $setOnInsert: { // Nur beim erstmaligen Erstellen setzen
                        status: 'offen' 
                    }
                },
                { upsert: true, new: true }
            );
        }  
        
        // === Veraltete Gruppen löschen ===
        // 4. Sammle alle Schlüssel der aktuell gültigen Gruppen
        const alleAktuellenGruppenSchluessel = Array.from(gruppenMap.keys());

        // 5. Lösche alle Gruppen aus der DB, deren Schlüssel NICHT in der aktuellen Liste ist
        const deleteResult = await KonfliktGruppe.deleteMany({ 
            gruppenSchluessel: { $nin: alleAktuellenGruppenSchluessel } 
        });

        if (deleteResult.deletedCount > 0) {
            console.log(`${deleteResult.deletedCount} veraltete Konfliktgruppen wurden gelöscht.`);
        }

        console.log(`Synchronisation abgeschlossen. ${gruppenMap.size} Konfliktgruppen in der DB.`);
    } catch (err) {
        console.error("Fehler bei der Synchronisation der Konfliktgruppen:", err);
        // Dieser Fehler sollte das Ergebnis des Hauptprozesses nicht unbedingt blockieren, aber geloggt werden.
    }
}

module.exports = {
    aktualisiereKonfliktGruppen
};