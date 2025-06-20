const mongoose = require('mongoose');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const KonfliktGruppe = require('../models/KonfliktGruppe');


/**
 * Ermittelt den Gesamtstatus einer Konfliktgruppe basierend auf den Status ihrer Einzelkonflikte.
 * @param {Array<Document>} konflikteInGruppe - Ein Array der KonfliktDokumentation-Objekte der Gruppe.
 * @returns {string} Der abgeleitete Status für die KonfliktGruppe.
 */
function determineGruppenStatus(konflikteInGruppe) {
    if (!konflikteInGruppe || konflikteInGruppe.length === 0) {
        // Eine Gruppe ohne aktive Konflikte kann als "gelöst" betrachtet werden.
        return 'vollstaendig_geloest';
    }

    const ersterStatus = konflikteInGruppe[0].status;
    const alleHabenGleichenStatus = konflikteInGruppe.every(k => k.status === ersterStatus);

    if (!alleHabenGleichenStatus) {
        // Wenn die Status gemischt sind, ist die Gruppe "invalide" oder in einem Übergangszustand.
        return 'invalide';
    }

    // Wenn alle den gleichen Status haben, mappen wir ihn auf den Gruppenstatus.
    switch (ersterStatus) {
        case 'offen':
            return 'offen';
        case 'in_bearbeitung': 
            return 'in_bearbeitung_verzicht';
        case 'in_bearbeitung_entgelt':
            return 'in_bearbeitung_entgelt';
        case 'in_bearbeitung_hoechstpreis':
            return 'in_bearbeitung_hoechstpreis';
        case 'geloest':
            return 'vollstaendig_geloest';
        default:
            return 'invalide'; // Fallback für unbekannte, aber einheitliche Status
    }
}


/**
 * Synchronisiert die KonfliktGruppe-Collection mit dem aktuellen Stand der Konflikte.
 * Findet alle nicht-gelösten Konflikte, gruppiert sie nach beteiligten Anfragen
 * und erstellt oder aktualisiert die persistenten KonfliktGruppe-Dokumente.
 */
async function aktualisiereKonfliktGruppen() {
    console.log("Starte Synchronisation der Konfliktgruppen...");
    
    try {
        // 1. Lade ALLE Konfliktdokumente, um den gesamten "Soll-Zustand" zu erfassen.
        const relevanteKonflikte = await KonfliktDokumentation.find({})
            .select('beteiligteAnfragen status ausloesenderKapazitaetstopf')
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet'); // Lade maxKapazitaet mit



        const gruppenMap = new Map();

        // 2. Gruppiere die Konflikte in-memory nach der exakten Zusammensetzung der beteiligten Anfragen
        for (const konflikt of relevanteKonflikte) {
            if (!konflikt.beteiligteAnfragen || konflikt.beteiligteAnfragen.length === 0) continue;
            
            const anfrageIdsStrings = konflikt.beteiligteAnfragen.map(a => a.toString()).sort();
            const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;
            // Schlüssel: "maxKap|anfrageId1#anfrageId2#..."
            const gruppenSchluessel = `${maxKap}|${anfrageIdsStrings.join('#')}`;          
            
            if (!gruppenMap.has(gruppenSchluessel)) {
                gruppenMap.set(gruppenSchluessel, {
                    beteiligteAnfragen: konflikt.beteiligteAnfragen,
                    konflikteInGruppe: []
                });
            }
            // Speichere das ganze (lean) Objekt, damit wir den Status haben
            gruppenMap.get(gruppenSchluessel).konflikteInGruppe.push(konflikt.toObject());
        }

        // 3. Führe für jede gefundene Gruppe ein "Upsert" (Update or Insert) in der DB durch
        for (const [gruppenSchluessel, gruppe] of gruppenMap.entries()) {
            const konflikteDerGruppe = await KonfliktDokumentation.find({ _id: { $in: gruppe.konflikteInGruppe } }).select('status');
            const neuerGruppenStatus = determineGruppenStatus(konflikteDerGruppe);
            await KonfliktGruppe.findOneAndUpdate(
                { gruppenSchluessel: gruppenSchluessel }, // Finde Gruppe mit diesem eindeutigen Schlüssel
                { 
                    $set: { // Setze/Aktualisiere diese Felder immer
                        beteiligteAnfragen: gruppe.beteiligteAnfragen,
                        // Speichere nur die _ids der Konflikte in der Gruppe
                        konflikteInGruppe: gruppe.konflikteInGruppe.map(k => k._id),
                        status: neuerGruppenStatus // Setze den neu ermittelten Status
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