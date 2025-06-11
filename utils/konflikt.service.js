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
        // 1. Finde alle Konfliktdokumente, die noch nicht final gelöst sind
        const relevanteKonflikte = await KonfliktDokumentation.find({ 
            status: { $nin: ['geloest', 'eskaliert'] } 
        }).select('beteiligteAnfragen');

        const gruppenMap = new Map();

        // 2. Gruppiere die Konflikte in-memory nach der exakten Zusammensetzung der beteiligten Anfragen
        for (const konflikt of relevanteKonflikte) {
            if (!konflikt.beteiligteAnfragen || konflikt.beteiligteAnfragen.length === 0) continue;
            
            const anfrageIdsStrings = konflikt.beteiligteAnfragen.map(a => a.toString()).sort();
            const gruppenSchluessel = anfrageIdsStrings.join('#');
            
            if (!gruppenMap.has(gruppenSchluessel)) {
                gruppenMap.set(gruppenSchluessel, {
                    beteiligteAnfragen: konflikt.beteiligteAnfragen,
                    konflikteInGruppe: []
                });
            }
            gruppenMap.get(gruppenSchluessel).konflikteInGruppe.push(konflikt._id);
        }

        // 3. Führe für jede gefundene Gruppe ein "Upsert" (Update or Insert) in der DB durch
        for (const [gruppenSchluessel, gruppe] of gruppenMap.entries()) {
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

        console.log(`Synchronisation abgeschlossen. ${gruppenMap.size} Konfliktgruppen in der DB.`);
    } catch (err) {
        console.error("Fehler bei der Synchronisation der Konfliktgruppen:", err);
        // Dieser Fehler sollte das Ergebnis des Hauptprozesses nicht unbedingt blockieren, aber geloggt werden.
    }
}

module.exports = {
    aktualisiereKonfliktGruppen
};