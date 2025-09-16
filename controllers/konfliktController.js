// slot-buchungs-app/controllers/konfliktController.js
const mongoose = require('mongoose'); // Für ObjectId.isValid
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const Anfrage = require('../models/Anfrage'); // für Populate
const {Slot} = require('../models/Slot'); // Benötigt, um Slot.VerweisAufTopf zu prüfen
const KonfliktGruppe = require('../models/KonfliktGruppe');
const konfliktService = require('../utils/konflikt.service');

// Wichtig: Die Zeitfenster-Sequenz für die Sortierung
const ZEITFENSTER_SEQUENZ = [
    '01-03', '03-05', '05-07', '07-09', '09-11', '11-13', 
    '13-15', '15-17', '17-19', '19-21', '21-23', '23-01'
];

// Definiere alle Status, die ein FINALES Ergebnis der Topf-Phase darstellen
const finaleTopfStatus = [
    'bestaetigt_topf',
    'bestaetigt_topf_entgelt',
    'bestaetigt_topf_hoechstpreis',
    'abgelehnt_topf_verzichtet',
    'abgelehnt_topf_verschoben',
    'abgelehnt_topf_entgelt',
    'abgelehnt_topf_marktanteil',
    'abgelehnt_topf_hoechstpreis',
    'abgelehnt_topf_hoechstpreis_ungueltig',
    'abgelehnt_topf_hoechstpreis_kein_gebot'
];

// Definiere alle Status, die ein FINALES Ergebnis der Slot-Phase darstellen
const finaleSlotStatus = [
    'bestaetigt_slot',                  
    'bestaetigt_slot_entgelt',          
    'bestaetigt_slot_hoechstpreis',     
    'abgelehnt_slot_verzichtet',        
    'abgelehnt_slot_verschoben',        
    'abgelehnt_slot_entgelt',           
    'abgelehnt_slot_hoechstpreis',      
    'abgelehnt_slot_hoechstpreis_ungueltig', 
    'abgelehnt_slot_hoechstpreis_kein_gebot'
];

// Diese Funktion vergleicht, ob alle IDs der Anfragen identisch sind.
function sindObjectIdArraysGleich(arr1, arr2) {
    if (!arr1 && !arr2) return true; // Beide null oder undefined sind gleich
    if (!arr1 || !arr2) return false; // Eines ist null/undefined, das andere nicht
    if (arr1.length !== arr2.length) return false;

    // Konvertiere zu Sets von Strings für den Vergleich
    const set1 = new Set(arr1.map(id => id.toString()));
    const set2 = new Set(arr2.map(id => id.toString()));

    if (set1.size !== set2.size) return false; // Sollte durch Längenprüfung schon abgedeckt sein, aber sicher ist sicher

    for (const idStr of set1) {
        if (!set2.has(idStr)) {
            return false;
        }
    }
    return true;
};

// HILFSFUNKTION 
/**
 * Aktualisiert den statusEinzelzuweisung für alle Slots einer Anfrage, die zu einem bestimmten Topf gehören,
 * und ruft dann die Methode zur Neuberechnung des Gesamtstatus der Anfrage auf.
 * @param {Document} anfrageDoc - Das bereits geladene und populierte Anfrage-Dokument.
 * @param {string} neuerEinzelStatus - Der neue Status für die relevanten Slot-Zuweisungen.
 * @param {ObjectId} ausloesenderTopfObjectId - Die ObjectId des Kapazitätstopfes, für den diese Entscheidung gilt.
 * @param {ObjectId|null} [konfliktDokuId=null] - Die ID des Topf-Konfliktdokuments
 * @returns {Promise<Anfrage|null>} Das aktualisierte Anfrage-Objekt oder null bei Fehler.
 */
function updateAnfrageSlotsStatusFuerTopf(anfrageDoc, neuerEinzelStatus, ausloesenderTopfObjectId, konfliktDokuId = null) {    

    if (!anfrageDoc || !anfrageDoc.ZugewieseneSlots) {
        console.warn(`Anfrage-Dokument für Update ungültig: ${anfrageDoc?._id} für updateAnfrageSlotsStatusFuerTopf`);
        return null;
    }

    //console.log(`updateAnfrageSlotsStatusFuerTopf: anfrageDoc ${anfrageDoc}, neuerEinzelStatus ${neuerEinzelStatus}, ausloesenderTopfObjectId ${ausloesenderTopfObjectId}, konfliktDokuId ${konfliktDokuId}`);

    let anfrageModifiziert = false;
    if (anfrageDoc.ZugewieseneSlots.length > 0) {
        for (const zuweisung of anfrageDoc.ZugewieseneSlots) {
            // Prüfe, ob der Slot in der Zuweisung zum aktuellen auslösenden Topf gehört
            //console.log(`zuweisung ${zuweisung}, zuweisung.slot ${zuweisung.slot}, zuweisung.slot.VerweisAufTopf ${zuweisung.slot.VerweisAufTopf}, ausloesenderTopfObjectId ${ausloesenderTopfObjectId}`);
            if (zuweisung.slot && zuweisung.slot.VerweisAufTopf && zuweisung.slot.VerweisAufTopf.equals(ausloesenderTopfObjectId)) {
                
                if(neuerEinzelStatus === 'wartet_konflikt_topf'){
                    zuweisung.finaleTopfStatus = 'entscheidung_ausstehend';
                    anfrageModifiziert = true;
                }
                if (zuweisung.statusEinzelzuweisung !== neuerEinzelStatus) {
                    zuweisung.statusEinzelzuweisung = neuerEinzelStatus;
                    anfrageModifiziert = true;
                }
                // Setze oder aktualisiere die Konflikt-Doku-ID
                if (konfliktDokuId && zuweisung.topfKonfliktDoku !== konfliktDokuId) {
                    zuweisung.topfKonfliktDoku = konfliktDokuId; // Setze ID
                    anfrageModifiziert = true;
                }
                // Wenn der neue Status ein finaler Topf-Status ist, speichere ihn auch im Snapshot-Feld.
                if (finaleTopfStatus.includes(neuerEinzelStatus)) {
                    if (zuweisung.finalerTopfStatus !== neuerEinzelStatus) {
                        zuweisung.finalerTopfStatus = neuerEinzelStatus;
                        anfrageModifiziert = true;
                    }
                }
            }
        }
    }

    if (anfrageModifiziert) {
        anfrageDoc.markModified('ZugewieseneSlots');        
        //console.log(`Einzelstatus und Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} auf ${anfrageDoc.Status} aktualisiert (neuer Einzelstatus für Topf ${ausloesenderTopfObjectId}: ${neuerEinzelStatus}).`);
    }
    return anfrageDoc;
};

// HILFSFUNKTION
/**
 * Aktualisiert den Status einer EINZELNEN Slot-Zuweisung innerhalb einer Anfrage.
 * und ruft dann die Methode zur Neuberechnung des Gesamtstatus der Anfrage auf.
 * @param {Document} anfrageDoc - Das bereits geladene und ggf. populierte Anfrage-Dokument.
 * @param {ObjectId|string} slotId - Der Slot, dessen Zuweisungsstatus geändert wird.
 * @param {string} neuerStatus - Der neue statusEinzelzuweisung
 * @param {ObjectId|null} [konfliktDokuId=null] - Die ID des Slot-Konfliktdokuments
 * @returns Promise<Anfrage|null>} Das aktualisierte Anfrage-Objekt oder null bei Fehler.
 */
function updateAnfrageEinzelSlotStatus(anfrageDoc, slotId, neuerStatus, konfliktDokuId = null) {    
    if (!anfrageDoc || !anfrageDoc.ZugewieseneSlots) return null;

    let anfrageModifiziert = false;
    for (const zuweisung of anfrageDoc.ZugewieseneSlots) {
        if (zuweisung.slot && zuweisung.slot._id.equals(slotId)) {
            if (zuweisung.statusEinzelzuweisung !== neuerStatus) {
                zuweisung.statusEinzelzuweisung = neuerStatus;
                anfrageModifiziert = true;
            }
            // Setze oder aktualisiere die Konflikt-Doku-ID
            if (konfliktDokuId && zuweisung.slotKonfliktDoku !== konfliktDokuId) {
                zuweisung.slotKonfliktDoku = konfliktDokuId;
                anfrageModifiziert = true;
            }
            // Wenn der neue Status ein finaler Slot-Status ist, speichere ihn auch im Snapshot-Feld.
                if (finaleSlotStatus.includes(neuerStatus)) {
                    if (zuweisung.finalerSlotStatus !== neuerStatus) {
                        zuweisung.finalerSlotStatus = neuerStatus;
                        anfrageModifiziert = true;
                    }
                }
            break; // Wir haben den Eintrag gefunden
        }
    }

    if (anfrageModifiziert) {
        anfrageDoc.markModified('ZugewieseneSlots');
        console.log(`Einzelstatus und Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} auf ${anfrageDoc.Status} aktualisiert (neuer Einzelstatus für Slot ${slotId}: ${neuerStatus}).`);
    }
    return anfrageDoc;
}

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines Einzelkonflikts im Kapazitätstopf
 * in der Phase "Verzicht/Verschub". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt (Typ KAPAZITAETSTOPF).
 * @param {Array} listeAnfragenMitVerzicht - Array von Anfrage-IDs.
 * @param {Array} listeAnfragenVerschubKoordination - Array von {anfrage, details} Objekten.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten, die gespeichert werden müssen.
 */
function resolveVerzichtVerschubForSingleTopfConflict(konflikt, listeAnfragenMitVerzicht = [], listeAnfragenVerschubKoordination = []) {
    if (konflikt.konfliktTyp !== 'KAPAZITAETSTOPF' || !konflikt.ausloesenderKapazitaetstopf) {
        throw new Error('Diese Funktion ist nur für Topf-Konflikte mit einem auslösenden Kapazitätstopf vorgesehen.');
    }

    const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;
    let anfragenToSave = new Map(); // Sammelt modifizierte Anfrage-Dokumente, um doppeltes Speichern zu vermeiden

    //console.log(konflikt);

    // Verzicht verarbeiten
    if (listeAnfragenMitVerzicht && Array.isArray(listeAnfragenMitVerzicht)) {
        konflikt.ListeAnfragenMitVerzicht = listeAnfragenMitVerzicht.map(item => 
            typeof item === 'string' ? item : item.anfrage || item._id || item
        );
        konflikt.markModified('ListeAnfragenMitVerzicht');
        for (const anfrageId of konflikt.ListeAnfragenMitVerzicht) {
            const anfrageDoc = konflikt.beteiligteAnfragen.find(a => a._id.equals(anfrageId));
            //console.log(`anfrageId ${anfrageId} \n\nkonflikt.beteiligteAnfragen ${konflikt.beteiligteAnfragen} \n\nanfrageDoc ${anfrageDoc}`);
            if (anfrageDoc) {
                const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageDoc, 'abgelehnt_topf_verzichtet', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} hat verzichtet.`;
            }            
        }
    }

    // Verschub/Koordination verarbeiten
    if (listeAnfragenVerschubKoordination && Array.isArray(listeAnfragenVerschubKoordination)) {
        konflikt.ListeAnfragenVerschubKoordination = listeAnfragenVerschubKoordination; // Erwartet [{anfrage, details}]
        konflikt.markModified('ListeAnfragenVerschubKoordination');
        for (const item of konflikt.ListeAnfragenVerschubKoordination) {
            // Annahme: 'abgelehnt_topf_verschoben' für DIESEN Konfliktpunkt, da die Anfrage eine Alternative hat
            const anfrageDoc = konflikt.beteiligteAnfragen.find(a => a._id.equals(item.anfrage));            
            if (anfrageDoc) {                
                const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageDoc, 'abgelehnt_topf_verschoben', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} wurde verschoben.`;
            }            
        }
    }

    // Aktive Anfragen für diesen Konflikt ermitteln (die nicht verzichtet oder verschoben wurden)
    const anfragenIdsMitVerzicht = new Set((konflikt.ListeAnfragenMitVerzicht || []).map(id => id.toString()));
    const anfragenIdsMitVerschub = new Set((konflikt.ListeAnfragenVerschubKoordination || []).map(item => item.anfrage.toString()));
        
    const aktiveAnfragenImKonflikt = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
        !anfragenIdsMitVerzicht.has(anfrageDoc._id.toString()) && 
        !anfragenIdsMitVerschub.has(anfrageDoc._id.toString())
    );

    // Prüfen, ob Kapazität nun ausreicht
    const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;
    if (aktiveAnfragenImKonflikt.length <= maxKap) {
        konflikt.zugewieseneAnfragen = aktiveAnfragenImKonflikt.map(a => a._id);
        // Alte Resolution-Felder für Entgelt/Höchstpreis zurücksetzen, falls dies eine neue Lösung ist
        konflikt.abgelehnteAnfragenEntgeltvergleich = [];
        konflikt.abgelehnteAnfragenHoechstpreis = [];
        konflikt.ReihungEntgelt = [];
        konflikt.ListeGeboteHoechstpreis = [];
        
        konflikt.status = 'geloest';
        konflikt.abschlussdatum = new Date();
        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub automatisch gelöst.`;

        for (const anfrageDoc of aktiveAnfragenImKonflikt) {
            const updatedAnfrage =  updateAnfrageSlotsStatusFuerTopf(anfrageDoc, 'bestaetigt_topf', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        }
        console.log(`Topf-Konflikt ${konflikt._id} automatisch nach Verzicht/Verschub gelöst.`);
    } else {
        // Konflikt besteht weiterhin, bereit für Entgeltvergleich
        konflikt.status = 'in_bearbeitung_entgelt';
        konflikt.zugewieseneAnfragen = []; // Noch keine finale Zuweisung in diesem Schritt
        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub nicht gelöst. Nächster Schritt: Entgeltvergleich.`;
        for (const anfrageDoc of aktiveAnfragenImKonflikt) {
            const updatedAnfrage =  updateAnfrageSlotsStatusFuerTopf(anfrageDoc, 'wartet_entgeltentscheidung_topf', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        }
        console.log(`Topf-Konflikt ${konflikt._id} nach Verzicht/Verschub nicht gelöst, Status: ${konflikt.status}.`);
    }
    // Alte Resolution-Felder zurücksetzen, falls dies eine neue Lösung ist
    konflikt.abgelehnteAnfragenEntgeltvergleich = [];
    konflikt.abgelehnteAnfragenHoechstpreis = [];
    konflikt.ReihungEntgelt = [];
    konflikt.ListeGeboteHoechstpreis = [];

    return { anfragenToSave };
};

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines EINZELNEN SLOT-Konflikts
 * in der Phase "Verzicht/Verschub". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt (Typ SLOT).
 * @param {Array} listeAnfragenMitVerzicht - Array von Anfrage-IDs.
 * @param {Array} listeAnfragenVerschubKoordination - Array von {anfrage, details} Objekten.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
function resolveVerzichtVerschubForSingleSlotConflict(konflikt, listeAnfragenMitVerzicht = [], listeAnfragenVerschubKoordination = []) {
    if (konflikt.konfliktTyp !== 'SLOT' || !konflikt.ausloesenderSlot) {
        throw new Error('Diese Funktion ist nur für Slot-Konflikte mit einem auslösenden Slot vorgesehen.');
    }
    const ausloesenderSlotId = konflikt.ausloesenderSlot._id;
    let anfragenToSave = new Map();

    // Verzicht und Verschub im Konfliktdokument festhalten
    konflikt.ListeAnfragenMitVerzicht = listeAnfragenMitVerzicht.map(item => (typeof item === 'string' ? item : (item.anfrage || item._id || item)));
    konflikt.ListeAnfragenVerschubKoordination = listeAnfragenVerschubKoordination;
    konflikt.markModified('ListeAnfragenMitVerzicht');
    konflikt.markModified('ListeAnfragenVerschubKoordination');

    // Aktualisiere Einzelstatus der Anfragen, die verzichtet oder verschoben wurden
    for (const anfrageId of konflikt.ListeAnfragenMitVerzicht) {
        // Wichtig: Wir nutzen hier die spezialisierte Funktion, die nur den EINEN Slot-Status ändert!
        const anfrageDoc = konflikt.beteiligteAnfragen.find(a => a._id.equals(anfrageId));
        if(anfrageDoc){
            const updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageDoc, ausloesenderSlotId, 'abgelehnt_slot_verzichtet');
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} hat verzichtet.`;
        }        
    }
    for (const item of konflikt.ListeAnfragenVerschubKoordination) {
        const anfrageDoc = konflikt.beteiligteAnfragen.find(a => a._id.equals(item.anfrage));
        if(anfrageDoc){
            const updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageDoc, ausloesenderSlotId, 'abgelehnt_slot_verschoben');
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} wurde verschoben.`;
        }        
    }
    
    // Ermittle "aktive" Anfragen, die noch um den Slot konkurrieren
    const anfragenIdsMitVerzichtSet = new Set(konflikt.ListeAnfragenMitVerzicht.map(id => id.toString()));
    const anfragenIdsMitVerschubSet = new Set(konflikt.ListeAnfragenVerschubKoordination.map(item => item.anfrage.toString()));
    const aktiveAnfragenImKonflikt = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
        !anfragenIdsMitVerzichtSet.has(anfrageDoc._id.toString()) && 
        !anfragenIdsMitVerschubSet.has(anfrageDoc._id.toString())
    );

    // Prüfe Kapazität: Die Kapazität eines Slots ist immer 1
    const maxKapazitaetSlot = 1;
    if (aktiveAnfragenImKonflikt.length <= maxKapazitaetSlot) {
        // Fall 1: Konflikt ist gelöst (0 oder 1 Anfrage übrig)
        // Alte Resolution-Felder für Entgelt/Höchstpreis zurücksetzen, falls dies eine neue Lösung ist
        konflikt.abgelehnteAnfragenEntgeltvergleich = [];
        konflikt.abgelehnteAnfragenHoechstpreis = [];
        konflikt.ReihungEntgelt = [];
        konflikt.ListeGeboteHoechstpreis = [];

        konflikt.zugewieseneAnfragen = aktiveAnfragenImKonflikt.map(a => a._id);
        konflikt.status = 'geloest';
        konflikt.abschlussdatum = new Date();
        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub automatisch gelöst.`;

        
        // Wenn genau eine Anfrage übrig ist, hat sie den Slot gewonnen
        if (aktiveAnfragenImKonflikt.length === 1) {
            const gewinnerAnfrage = aktiveAnfragenImKonflikt[0];
            // Hier könnte ein finaler Status wie 'bestaetigt_final' gesetzt werden,
            // aber für Konsistenz nutzen wir 'bestaetigt_slot'.
            const updatedAnfrage = updateAnfrageEinzelSlotStatus(gewinnerAnfrage, ausloesenderSlotId, 'bestaetigt_slot');
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        }
        console.log(`Slot-Konflikt ${konflikt._id} automatisch nach Verzicht/Verschub gelöst.`);
    } else {
        // Fall 2: Konflikt besteht weiterhin, bereit für Entgeltvergleich
        konflikt.status = 'in_bearbeitung_entgelt';
        konflikt.zugewieseneAnfragen = [];
        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub nicht gelöst. Nächster Schritt: Entgeltvergleich.`;
        
        
        // Setze den Status der verbleibenden Anfragen auf "wartet auf Entgeltentscheidung für Slot"
        for (const anfrageDoc of aktiveAnfragenImKonflikt) {
            const updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageDoc, ausloesenderSlotId, 'wartet_entgeltentscheidung_slot');
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        }
        console.log(`Slot-Konflikt ${konflikt._id} nach Verzicht/Verschub nicht gelöst, Status: ${konflikt.status}.`);
    }
    
    // Alte Resolution-Felder zurücksetzen, da eine neue Entscheidung getroffen wurde
    konflikt.abgelehnteAnfragenEntgeltvergleich = [];
    konflikt.abgelehnteAnfragenHoechstpreis = [];
    konflikt.ReihungEntgelt = [];
    konflikt.ListeGeboteHoechstpreis = [];

    return { anfragenToSave };
}

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines Einzelkonflikts für einen Kapazitätstopf
 * in der Phase "Entgeltvergleich". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte Topf-KonfliktDokumentation-Objekt.
 * @param {Array} [evuReihungen=[]] - Optionale, vom Koordinator übermittelte Reihung für EVUs.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
function resolveEntgeltvergleichForSingleTopfConflict(konflikt, evuReihungen = {}) {
        if (konflikt.konfliktTyp !== 'KAPAZITAETSTOPF' || !konflikt.ausloesenderKapazitaetstopf) {
            throw new Error('Diese Funktion ist nur für Topf-Konflikte vorgesehen.');
        }
        //console.log(konflikt);
        const ausloesenderTopf = konflikt.ausloesenderKapazitaetstopf; // Ist bereits populiert
        const ausloesenderTopfId = ausloesenderTopf._id;
        const maxKap = ausloesenderTopf.maxKapazitaet;
        let anfragenToSave = new Map();

        // Dokumentiere die übermittelte EVU-Reihung
        if (evuReihungen && evuReihungen.length > 0) {
            konflikt.evuReihungen = evuReihungen;
            konflikt.markModified('evuReihungen');
        }

        // Lade die ListeDerSlots des Topfes, um die Gesamtanzahl für die Marktanteil-Regel zu bekommen
        // Dies erfordert, dass der aufrufende Controller den Topf mit .populate('ListeDerSlots') lädt.
        // Wir stellen das im `fuehreEinzelEntgeltvergleichDurch` sicher.
        if (!ausloesenderTopf.ListeDerSlots) {
            throw new Error(`ListeDerSlots für Topf ${ausloesenderTopf.TopfID} nicht geladen. Population im Controller erforderlich.`);
        }
        //Das Limit sind 80% der 70% zu vergebender RV-Kapazität, also insgesamt maximal abgerundet 56% aller Slots in diesem Topf
        const evuMarktanteilLimit = Math.floor(0.56 * ausloesenderTopf.ListeDerSlots.length);
        konflikt.abgelehnteAnfragenMarktanteil = []; // Zurücksetzen für diese Runde
        console.log(`Marktanteil-Limit für jedes EVU in diesem Topf: ${evuMarktanteilLimit} Kapazitäten`);

        // Aktive Anfragen für diesen Konflikt ermitteln (die nicht verzichtet oder verschoben wurden)
        // Dies basiert auf den bereits im Konfliktdokument gespeicherten Listen
        const anfragenIdsMitVerzicht = new Set((konflikt.ListeAnfragenMitVerzicht || []).map(id => id.toString()));
        const anfragenIdsMitVerschub = new Set((konflikt.ListeAnfragenVerschubKoordination || []).map(item => item.anfrage.toString()));

        let aktiveAnfragenPool = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
            !anfragenIdsMitVerzicht.has(anfrageDoc._id.toString()) && 
            !anfragenIdsMitVerschub.has(anfrageDoc._id.toString())
        );

        // ----- PHASE 2a - EVU-interne Reihung und Marktanteil-Filterung -----
        const anfragenProEVU = new Map();
        aktiveAnfragenPool.forEach(a => {
            if (!anfragenProEVU.has(a.EVU)) anfragenProEVU.set(a.EVU, []);
            anfragenProEVU.get(a.EVU).push(a);
        });

        let aktiveAnfragenFuerEntgeltvergleich = [];

        for (const [evu, anfragen] of anfragenProEVU.entries()) {
            if (anfragen.length > evuMarktanteilLimit) {
                let reihungFuerEVU = {};
                if(evuReihungen.length > 0){
                    reihungFuerEVU = evuReihungen.find(r => r.evu === evu);
                }

                if (!reihungFuerEVU || !reihungFuerEVU.anfrageIds || reihungFuerEVU.anfrageIds.length < anfragen.length) {
                    // Fehler: Wenn ein EVU über dem Limit ist, MUSS eine vollständige Reihung übermittelt werden.
                    throw new Error(`Für EVU "${evu}" ist eine vollständige Reihung erforderlich, da die Anzahl der Anfragen (${anfragen.length}) das Marktanteil-Limit (${evuMarktanteilLimit}) übersteigt.`);
                }

                const priorisierteAnfrageIds = new Set(reihungFuerEVU.anfrageIds.slice(0, evuMarktanteilLimit).map(id => id.toString()));
                
                for (const anfrage of anfragen) {
                    if (priorisierteAnfrageIds.has(anfrage._id.toString())) {
                        aktiveAnfragenFuerEntgeltvergleich.push(anfrage); // Diese Anfrage darf am Entgeltvergleich teilnehmen
                        console.log(`Anfrage ${anfrage.AnfrageID_Sprechend} von ${anfrage.EVU} ist unterhalb des Marktanteil-Limits (${evuMarktanteilLimit}) und wird in den Entgeltvergleich aufgenommen.`);
                        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${anfrage.AnfrageID_Sprechend} von ${anfrage.EVU} ist unterhalb des Marktanteil-Limits (${evuMarktanteilLimit}) und wird in den Entgeltvergleich aufgenommen.`;
                    } else {
                        konflikt.abgelehnteAnfragenMarktanteil.push(anfrage._id); // Diese wird wegen EVU-Reihung abgelehnt
                        console.log(`Anfrage ${anfrage.AnfrageID_Sprechend} von ${anfrage.EVU} wegen Marktanteil-Limit (${evuMarktanteilLimit}) abgelehnt.`);
                        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${anfrage.AnfrageID_Sprechend} von ${anfrage.EVU} wegen Marktanteil-Limit (${evuMarktanteilLimit}) abgelehnt.`;
                        let updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrage, 'abgelehnt_topf_marktanteil', ausloesenderTopfId);
                        if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                    }
                }
            } else {
                // EVU ist innerhalb seines Limits, alle Anfragen bleiben im Pool
                aktiveAnfragenFuerEntgeltvergleich.push(...anfragen);
                console.log(`Alle Anfragen von ${anfragen[0].EVU} sind unterhalb des Marktanteil-Limits (${evuMarktanteilLimit}) und werden in den Entgeltvergleich aufgenommen.`);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Alle Anfragen von ${anfragen[0].EVU} sind unterhalb des Marktanteil-Limits (${evuMarktanteilLimit}) und werden in den Entgeltvergleich aufgenommen.`;
            }
        }
        konflikt.markModified('abgelehnteAnfragenMarktanteil');        
        
        // ----- PHASE 2b - EVU-übergreifender Entgeltvergleich (mit der bereinigten Liste) -----
        console.log(`Topf-Konflikt ${konflikt._id}: Entgeltvergleich wird durchgeführt für ${aktiveAnfragenFuerEntgeltvergleich.length} Anfragen.`);

        // ReihungEntgelt automatisch erstellen und sortieren
        konflikt.ReihungEntgelt = aktiveAnfragenFuerEntgeltvergleich
            .map(anfr => ({
                anfrage: anfr,
                entgelt: anfr.Entgelt || 0, // Nutze das in der Anfrage gespeicherte Entgelt                
            }))
            .sort((a, b) => (b.entgelt || 0) - (a.entgelt || 0)); // Absteigend nach Entgelt

        konflikt.ReihungEntgelt.forEach((item, index) => item.rang = index + 1);
        konflikt.markModified('ReihungEntgelt');
        console.log(`Topf-Konflikt ${konflikt._id}: ReihungEntgelt automatisch erstellt mit ${konflikt.ReihungEntgelt.length} Einträgen.`);

        // Felder für Zuweisung/Ablehnung zurücksetzen, bevor sie neu befüllt werden
        konflikt.zugewieseneAnfragen = [];
        konflikt.abgelehnteAnfragenEntgeltvergleich = [];
        konflikt.abgelehnteAnfragenHoechstpreis = []; // Sicherstellen, dass dies auch leer ist für diese Phase
        
        let anfragenFuerHoechstpreis = []; // Sammelt Anfrage-IDs für den Fall eines Gleichstands  

        // Verarbeite die Reihung in Blöcken von gleichem Entgelt
        let verarbeiteteAnfragenIndex = 0;
        while (verarbeiteteAnfragenIndex < konflikt.ReihungEntgelt.length) {
            const aktuellesEntgelt = konflikt.ReihungEntgelt[verarbeiteteAnfragenIndex].entgelt;
            
            // Finde alle Anfragen mit diesem Entgelt (der aktuelle "Block")
            const blockMitGleichemEntgelt = konflikt.ReihungEntgelt.filter(
                r => r.entgelt === aktuellesEntgelt
            );
            
            const anzahlKandidatenImBlock = blockMitGleichemEntgelt.length;
            const anzahlBisherZugewiesen = konflikt.zugewieseneAnfragen.length;
            const anzahlVerbleibendePlaetze = maxKap - anzahlBisherZugewiesen;

            if (anzahlKandidatenImBlock <= anzahlVerbleibendePlaetze) {
                // **Fall 1: Der gesamte Block passt noch in die Kapazität.**
                // Alle Anfragen in diesem Block werden zugewiesen.
                for (const anfrageItem of blockMitGleichemEntgelt) {
                    konflikt.zugewieseneAnfragen.push(anfrageItem.anfrage._id);
                    let updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageItem.anfrage, 'bestaetigt_topf_entgelt', ausloesenderTopfId);
                    if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                    konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} gewinnt im Entgeltvergleich.`;
                }
            } else {
                // **Fall 2: Der Block passt NICHT mehr komplett rein.**
                // Nur noch `anzahlVerbleibendePlaetze` können vergeben werden.
                if (anzahlVerbleibendePlaetze > 0) {
                    // Unauflösbarer Gleichstand um die letzten Plätze -> Höchstpreisverfahren
                    anfragenFuerHoechstpreis = blockMitGleichemEntgelt.map(item => item.anfrage);
                }
                // Alle Anfragen in diesem Block (und alle folgenden mit niedrigerem Entgelt) werden
                // entweder Kandidaten für HP oder direkt abgelehnt.
                // Die Schleife kann hier beendet werden, der Rest wird abgelehnt.
                for (const anfrageItem of blockMitGleichemEntgelt) {
                    if (!anfragenFuerHoechstpreis.some(anf => (anf._id).equals(anfrageItem.anfrage._id))) {
                        konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageItem.anfrage._id);
                        let updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageItem.anfrage, 'abgelehnt_topf_entgelt', ausloesenderTopfId);
                        if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} unterliegt im Entgeltvergleich.`;
                    }
                }
            }

            // Setze den Index auf die nächste Anfrage mit einem anderen Entgelt
            verarbeiteteAnfragenIndex += anzahlKandidatenImBlock;
            
            // Wenn wir im HP-Verfahren sind, werden alle restlichen Anfragen abgelehnt
            if (anfragenFuerHoechstpreis.length > 0) {
                const restlicheAnfragen = konflikt.ReihungEntgelt.slice(verarbeiteteAnfragenIndex);
                for (const anfrageItem of restlicheAnfragen) {
                    konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageItem.anfrage._id);
                    let updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageItem.anfrage, 'abgelehnt_topf_entgelt', ausloesenderTopfId);
                    if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                    konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} unterliegt im Entgeltvergleich.`;
                }
                break; // Schleife beenden
            }
        } // Ende der while-Schleife        
        
        // Setze finalen Status für diesen Schritt
        if (anfragenFuerHoechstpreis.length > 0) {
            konflikt.status = 'in_bearbeitung_hoechstpreis';
            for (const anfrage of anfragenFuerHoechstpreis) {
                let updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrage, 'wartet_hoechstpreis_topf', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} geht in das Höchstpreisverfahren.`;
            }
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Entgeltvergleich am ${new Date().toLocaleString()} führte zu Gleichstand. Höchstpreisverfahren für ${anfragenFuerHoechstpreis.length} Anfragen eingeleitet.`;
        } else { // Kein Gleichstand, Konflikt durch Entgelt gelöst
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt durch Entgeltvergleich am ${new Date().toLocaleString()} gelöst.`;
        }
        
        konflikt.markModified('zugewieseneAnfragen');
        konflikt.markModified('abgelehnteAnfragenEntgeltvergleich');
        konflikt.markModified('abgelehnteAnfragenMarktanteil');

    return { anfragenToSave };
};

/**
 * Service-Funktion: Führt den Entgeltvergleich für einen EINZELNEN SLOT-Konflikt durch.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt (Typ SLOT).
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
function resolveEntgeltvergleichForSingleSlotConflict(konflikt) {
    if (konflikt.konfliktTyp !== 'SLOT' || !konflikt.ausloesenderSlot) {
        throw new Error('Diese Funktion ist nur für Slot-Konflikte vorgesehen.');
    }

    const ausloesenderSlotId = konflikt.ausloesenderSlot._id;
    let anfragenToSave = new Map();
    const maxKapazitaetSlot = 1; // Kapazität eines Slots ist immer 1
    

    // Aktive Anfragen für diesen Slot-Konflikt ermitteln
    const anfragenIdsMitVerzicht = new Set((konflikt.ListeAnfragenMitVerzicht || []).map(id => id.toString()));
    const anfragenIdsMitVerschub = new Set((konflikt.ListeAnfragenVerschubKoordination || []).map(item => item.anfrage.toString()));
    
    const aktiveAnfragen = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
        !anfragenIdsMitVerzicht.has(anfrageDoc._id.toString()) && 
        !anfragenIdsMitVerschub.has(anfrageDoc._id.toString())
    );
    console.log(`Slot-Konflikt ${konflikt._id}: Entgeltvergleich wird durchgeführt für ${aktiveAnfragen.length} Anfragen.`);


    // ReihungEntgelt automatisch erstellen und sortieren
    konflikt.ReihungEntgelt = aktiveAnfragen
        .map(anfr => ({
            id: anfr._id,
            anfrage: anfr,
            entgelt: anfr.Entgelt || 0,
        }))
        .sort((a, b) => (b.entgelt || 0) - (a.entgelt || 0));
    
    konflikt.ReihungEntgelt.forEach((item, index) => item.rang = index + 1);
    konflikt.markModified('ReihungEntgelt');
    console.log(`Slot-Konflikt ${konflikt._id}: ReihungEntgelt automatisch erstellt mit ${konflikt.ReihungEntgelt.length} Einträgen.`);


    // Felder für Zuweisung/Ablehnung zurücksetzen
    konflikt.zugewieseneAnfragen = [];
    konflikt.abgelehnteAnfragenEntgeltvergleich = [];
    konflikt.abgelehnteAnfragenHoechstpreis = [];
            
    // Zuweisung basierend auf der Reihung
    if (konflikt.ReihungEntgelt.length === 0) {
        // Keine aktiven Anfragen mehr übrig
        konflikt.status = 'geloest';
        konflikt.abschlussdatum = new Date();
    } else {
        const hoechstesEntgelt = konflikt.ReihungEntgelt[0].entgelt;
        const kandidatenMitHoechstemEntgelt = konflikt.ReihungEntgelt.filter(r => r.entgelt === hoechstesEntgelt);

        if (kandidatenMitHoechstemEntgelt.length > maxKapazitaetSlot) {
            // **Fall 1: Gleichstand an der Spitze -> Höchstpreisverfahren**
            konflikt.status = 'in_bearbeitung_hoechstpreis';
            for (const anfrageItem of kandidatenMitHoechstemEntgelt) {
                const updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageItem.anfrage, ausloesenderSlotId, 'wartet_hoechstpreis_slot');
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} geht in das Höchstpreisverfahren.`;
            }
            // Alle anderen mit geringerem Entgelt werden direkt abgelehnt
            const anfragenMitGeringeremEntgelt = konflikt.ReihungEntgelt.filter(r => r.entgelt < hoechstesEntgelt);
            for (const anfrageItem of anfragenMitGeringeremEntgelt) {
                konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageItem.anfrage._id);
                const updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageItem.anfrage, ausloesenderSlotId, 'abgelehnt_slot_entgelt');
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} unterliegt im Entgeltvergleich.`;
            }
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Entgeltvergleich am ${new Date().toLocaleString()} führte zu Gleichstand. Höchstpreisverfahren für ${kandidatenMitHoechstemEntgelt.length} Anfragen eingeleitet.`;

        } else {
            // **Fall 2: Eindeutiger Gewinner -> Konflikt gelöst**
            const gewinnerAnfrage = konflikt.ReihungEntgelt[0].anfrage;
            konflikt.zugewieseneAnfragen.push(gewinnerAnfrage._id);
            const updatedGewinner = updateAnfrageEinzelSlotStatus(gewinnerAnfrage, ausloesenderSlotId, 'bestaetigt_slot_entgelt');
            if(updatedGewinner) anfragenToSave.set(updatedGewinner._id.toString(), updatedGewinner);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedGewinner.AnfrageID_Sprechend} gewinnt im Entgeltvergleich.`;

            // Alle anderen ablehnen
            const verliererAnfragen = konflikt.ReihungEntgelt.slice(1);
            for (const anfrageItem of verliererAnfragen) {
                konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageItem.anfrage._id);
                const updatedVerlierer = updateAnfrageEinzelSlotStatus(anfrageItem.anfrage, ausloesenderSlotId, 'abgelehnt_slot_entgelt');
                if(updatedVerlierer) anfragenToSave.set(updatedVerlierer._id.toString(), updatedVerlierer);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedVerlierer.AnfrageID_Sprechend} unterliegt im Entgeltvergleich.`;
            }
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Slot-Konflikt durch Entgeltvergleich am ${new Date().toLocaleString()} gelöst.`;

        }
    }
    
    konflikt.markModified('zugewieseneAnfragen');
    konflikt.markModified('abgelehnteAnfragenEntgeltvergleich');

    return { anfragenToSave };
}

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines Einzelkonflikts
 * in der Phase "Höchstpreisverfahren". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt.
 * @param {Array} listeGeboteHoechstpreis - Array von {anfrage, gebot} Objekten aus dem Request.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
function resolveHoechstpreisForSingleTopfConflict(konflikt, listeGeboteHoechstpreis = []) {
    if (konflikt.konfliktTyp !== 'KAPAZITAETSTOPF' || !konflikt.ausloesenderKapazitaetstopf) {
            throw new Error('Diese Funktion ist nur für Topf-Konflikte vorgesehen.');
        }
    //console.log(listeGeboteHoechstpreis);
    konflikt.ListeGeboteHoechstpreis = listeGeboteHoechstpreis; // Speichere alle eingegangenen Gebote
    konflikt.markModified('ListeGeboteHoechstpreis');

    const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;
    let anfragenToSave = new Map();

    // 1. Anfragen identifizieren, die bieten sollten und Gebote validieren
    const anfragenKandidatenFuerHP = konflikt.beteiligteAnfragen.filter(aDoc => {
        //console.log(aDoc.ZugewieseneSlots);
        // Gib nur Anfragen zurück, bei denen auf einen Höchstpreis gewartet wird
        for(const slot of aDoc.ZugewieseneSlots){
            //mindestens 1 Slot wartet auf Höchstpreisentscheidung
            if(slot.statusEinzelzuweisung === 'wartet_hoechstpreis_topf'){return true;}
        }
        return false; // keine der Slots der Anfrage wartet auf Höchtpreisentscheidung
    });

    //console.log(anfragenKandidatenFuerHP);

    let valideGebote = [];
    let anfragenOhneValidesGebot = [];

    for (const anfrageKandidat of anfragenKandidatenFuerHP) {
        //console.log(anfrageKandidat);
        //console.log(listeGeboteHoechstpreis);
        const gebotEingang = listeGeboteHoechstpreis.find(
            g => g.anfrage && g.anfrage.toString() === anfrageKandidat._id.toString()
        );
        //console.log(gebotEingang);
        if (gebotEingang && typeof gebotEingang.gebot === 'number') {
            if (gebotEingang.gebot > (anfrageKandidat.Entgelt || 0)) {
                valideGebote.push({ anfrage: anfrageKandidat, gebot: gebotEingang.gebot });
            } else {
                anfragenOhneValidesGebot.push(anfrageKandidat._id);
                const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageKandidat, 'abgelehnt_topf_hoechstpreis_ungueltig', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} hat kein gültiges Angebot abgegeben.`;
            }
        } else {
            anfragenOhneValidesGebot.push(anfrageKandidat._id);
            const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrageKandidat, 'abgelehnt_topf_hoechstpreis_kein_gebot', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} hat kein Angebot abgegeben.`;
        }
    }
    // Füge Anfragen ohne valides Gebot direkt zu den abgelehnten im Konfliktdokument hinzu
    anfragenOhneValidesGebot.forEach(id => konflikt.abgelehnteAnfragenHoechstpreis.addToSet(id));
    konflikt.markModified('abgelehnteAnfragenHoechstpreis');


    valideGebote.sort((a, b) => (b.gebot || 0) - (a.gebot || 0)); // Absteigend sortieren

    // 2. Verbleibende Kapazität ermitteln
    const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;
    // Anzahl der bereits vor dieser HP-Runde sicher zugewiesenen Anfragen
    const bereitsSicherZugewieseneAnzahl = konflikt.zugewieseneAnfragen.length;
    let verbleibendeKapFuerHP = maxKap - bereitsSicherZugewieseneAnzahl;
    if (verbleibendeKapFuerHP < 0) verbleibendeKapFuerHP = 0;

    let neuZugewiesenInHP = [];
    let neuAbgelehntInHPWegenKap = [];
    let verbleibenImWartestatusHP = [];

    console.log(`HP-Runde: maxKap=${maxKap}, bereitsZugewiesen=${bereitsSicherZugewieseneAnzahl}, verbleibend=${verbleibendeKapFuerHP}`);
    //console.log("Valide Gebote sortiert:", valideGebote);


    // 3. Valide Gebote verarbeiten
    for (let i = 0; i < valideGebote.length; i++) {
        const aktuellesGebot = valideGebote[i];
        const anfrage = aktuellesGebot.anfrage;

        if (verbleibendeKapFuerHP > 0) {
            let istGleichstandAnGrenzeUndUnaufloesbar = false;
            // Prüfe, ob wir an der Grenze sind und es einen Gleichstand gibt, der nicht alle aufnehmen kann
            if (valideGebote.filter(g => g.gebot === aktuellesGebot.gebot).length > verbleibendeKapFuerHP && 
                valideGebote.map(g => g.gebot).lastIndexOf(aktuellesGebot.gebot) >= i + verbleibendeKapFuerHP -1 && // aktuelles Gebot ist Teil der Grenzgruppe
                valideGebote.map(g => g.gebot).indexOf(aktuellesGebot.gebot) < i + verbleibendeKapFuerHP ) {
                    istGleichstandAnGrenzeUndUnaufloesbar = true;
            }

            if (istGleichstandAnGrenzeUndUnaufloesbar) {
                valideGebote.filter(g => g.gebot === aktuellesGebot.gebot).forEach(gEqual => {
                    if (!verbleibenImWartestatusHP.some(anf => (anf._id).equals(gEqual.anfrage._id))) {
                        verbleibenImWartestatusHP.push(gEqual.anfrage);
                    }
                });
                verbleibendeKapFuerHP = 0; // Blockiert für diese Runde
                // Setze i, um die Schleife nach dieser Gleichstandsgruppe fortzusetzen (für Ablehnungen)
                const naechstesAnderesGebotIndex = valideGebote.findIndex(g => g.gebot < aktuellesGebot.gebot);
                i = (naechstesAnderesGebotIndex === -1) ? valideGebote.length -1 : naechstesAnderesGebotIndex -1;
            } else { // Eindeutig gewonnen oder Gleichstand, der noch reinpasst
                neuZugewiesenInHP.push(anfrage._id);
                const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrage, 'bestaetigt_topf_hoechstpreis', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} gewinnt im Höchstpreisverfahren.`;
                verbleibendeKapFuerHP--;
            }
        } else { // Keine Kapazität mehr
            if (!verbleibenImWartestatusHP.some(idW => (idW._id).equals(anfrage._id))) {
                neuAbgelehntInHPWegenKap.push(anfrage._id);
                const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrage, 'abgelehnt_topf_hoechstpreis', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} unterliegt im Höchstpreisverfahren.`;
            }
        }
    }

    // 4. Konfliktdokument aktualisieren
    neuZugewiesenInHP.forEach(id => konflikt.zugewieseneAnfragen.addToSet(id));
    neuAbgelehntInHPWegenKap.forEach(id => konflikt.abgelehnteAnfragenHoechstpreis.addToSet(id));
        
    konflikt.markModified('zugewieseneAnfragen');
    konflikt.markModified('abgelehnteAnfragenHoechstpreis');

    // Finalen Status für diesen Schritt setzen
    if (verbleibenImWartestatusHP.length > 0) {
        konflikt.status = 'in_bearbeitung_hoechstpreis'; // Bleibt für nächste Runde
        konflikt.notizen = `${konflikt.notizen || ''}\nHP-Runde (${new Date().toLocaleString()}): Erneuter Gleichstand für ${verbleibenImWartestatusHP.length} Anfragen. Nächste Bieterrunde erforderlich. Zugewiesen: ${neuZugewiesenInHP.length}, Abgelehnt wg. Kap: ${neuAbgelehntInHPWegenKap.length}, Ungült./Kein Gebot: ${anfragenOhneValidesGebot.length}.`;
        for (const anfrage of verbleibenImWartestatusHP) { // Status der Wartenden explizit setzen/bestätigen
            const updatedAnfrage = updateAnfrageSlotsStatusFuerTopf(anfrage, 'wartet_hoechstpreis_topf', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} geht erneut in das Höchstpreisverfahren.`;
        }
    } else {
        konflikt.status = 'geloest';
        konflikt.abschlussdatum = new Date();
        konflikt.notizen = `${konflikt.notizen || ''}\nKonflikt durch Höchstpreisverfahren am ${new Date().toLocaleString()} gelöst. Zugewiesen: ${neuZugewiesenInHP.length}, Abgelehnt wg. Kap: ${neuAbgelehntInHPWegenKap.length}, Ungült./Kein Gebot: ${anfragenOhneValidesGebot.length}.`;
    }

    return {anfragenToSave};
}

/**
 * Service-Funktion: Führt das Höchstpreisverfahren für einen EINZELNEN SLOT-Konflikt durch.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt (Typ SLOT).
 * @param {Array} listeGeboteHoechstpreis - Array von {anfrage, gebot} Objekten aus dem Request.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
function resolveHoechstpreisForSingleSlotConflict(konflikt, listeGeboteHoechstpreis = []) {
    if (konflikt.konfliktTyp !== 'SLOT' || !konflikt.ausloesenderSlot) {
        throw new Error('Diese Funktion ist nur für Slot-Konflikte vorgesehen.');
    }
    
    konflikt.ListeGeboteHoechstpreis = listeGeboteHoechstpreis;
    konflikt.markModified('ListeGeboteHoechstpreis');

    const ausloesenderSlotId = konflikt.ausloesenderSlot._id;
    let anfragenToSave = new Map();

    // 1. Kandidaten identifizieren und Gebote validieren
    const anfragenKandidaten = konflikt.beteiligteAnfragen.filter(aDoc =>
        aDoc.ZugewieseneSlots.some(zs => zs.statusEinzelzuweisung === 'wartet_hoechstpreis_slot' && zs.slot?._id.equals(ausloesenderSlotId))
    );

    let valideGebote = [];
    konflikt.abgelehnteAnfragenHoechstpreis = []; // Liste für diese Runde zurücksetzen

    for (const anfrageKandidat of anfragenKandidaten) {
        const gebotEingang = listeGeboteHoechstpreis.find(
            g => g.anfrage && g.anfrage.toString() === anfrageKandidat._id.toString()
        );
        if (gebotEingang && typeof gebotEingang.gebot === 'number') {
            if (gebotEingang.gebot > (anfrageKandidat.Entgelt || 0)) {
                valideGebote.push({ anfrage: anfrageKandidat, gebot: gebotEingang.gebot });
            } else {
                konflikt.abgelehnteAnfragenHoechstpreis.push(anfrageKandidat._id);
                let updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageKandidat, ausloesenderSlotId, 'abgelehnt_slot_hoechstpreis_ungueltig');
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} hat im Höchstpreisverfahren kein gültiges Angebot abgegeben.`;
            }
        } else {
            konflikt.abgelehnteAnfragenHoechstpreis.push(anfrageKandidat._id);
            let updatedAnfrage = updateAnfrageEinzelSlotStatus(anfrageKandidat, ausloesenderSlotId, 'abgelehnt_slot_hoechstpreis_kein_gebot');
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} hat im Höchstpreisverfahren kein Angebot abgegeben.`;
        }
    }
    konflikt.markModified('abgelehnteAnfragenHoechstpreis');
    
    valideGebote.sort((a, b) => (b.gebot || 0) - (a.gebot || 0));

    // 2. Gebote verarbeiten
    konflikt.zugewieseneAnfragen = []; // Für diese Phase zurücksetzen
    let anfragenInWarteschleifeHP = [];

    if (valideGebote.length === 0) {
        // Kein einziges valides Gebot abgegeben. Alle Kandidaten wurden bereits als abgelehnt markiert.
        konflikt.status = 'geloest'; // Der Konflikt ist gelöst, da niemand den Slot bekommt.
        konflikt.abschlussdatum = new Date();
    } else if (valideGebote.length === 1) {
        // **Fall 1: Nur ein valides Gebot.** Eindeutiger Gewinner.
        const gewinnerAnfrage = valideGebote[0].anfrage;
        konflikt.zugewieseneAnfragen.push(gewinnerAnfrage._id);
        let updatedAnfrage = updateAnfrageEinzelSlotStatus(gewinnerAnfrage, ausloesenderSlotId, 'bestaetigt_slot_hoechstpreis');
        if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} gewinnt im Höchstpreisverfahren.`;
        konflikt.status = 'geloest';
        konflikt.abschlussdatum = new Date();
    } else { // Mehr als ein valides Gebot
        const hoechstesGebot = valideGebote[0].gebot;
        const anzahlMitHoechstemGebot = valideGebote.filter(g => g.gebot === hoechstesGebot).length;

        if (anzahlMitHoechstemGebot > 1) {
            // **Fall 2: Gleichstand an der Spitze.**
            konflikt.status = 'in_bearbeitung_hoechstpreis'; // Bleibt für nächste Runde
            const kandidatenFuerNaechsteRunde = valideGebote.filter(g => g.gebot === hoechstesGebot);
            const verliererDieserRunde = valideGebote.filter(g => g.gebot < hoechstesGebot);
            
            for (const kandidat of kandidatenFuerNaechsteRunde) {
                anfragenInWarteschleifeHP.push(kandidat.anfrage._id);
                let updatedAnfrage = updateAnfrageEinzelSlotStatus(kandidat.anfrage, ausloesenderSlotId, 'wartet_hoechstpreis_slot');
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} geht erneut in das Höchstpreisverfahren.`;
            }
            for (const verlierer of verliererDieserRunde) {
                konflikt.abgelehnteAnfragenHoechstpreis.push(verlierer.anfrage._id);
                let updatedAnfrage = updateAnfrageEinzelSlotStatus(verlierer.anfrage, ausloesenderSlotId, 'abgelehnt_slot_hoechstpreis');
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} unterliegt im Höchstpreisverfahren.`;
            }
        } else {
            // **Fall 3: Eindeutiger Höchstbietender.**
            const gewinnerAnfrage = valideGebote[0].anfrage;
            konflikt.zugewieseneAnfragen.push(gewinnerAnfrage._id);
            let updatedAnfrage = updateAnfrageEinzelSlotStatus(gewinnerAnfrage, ausloesenderSlotId, 'bestaetigt_slot_hoechstpreis');
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} gewinnt im Höchstpreisverfahren.`;
            
            // Alle anderen mit validen Geboten werden abgelehnt
            const verliererAnfragen = valideGebote.slice(1);
            for (const verlierer of verliererAnfragen) {
                konflikt.abgelehnteAnfragenHoechstpreis.push(verlierer.anfrage._id);
                let updatedAnfrage = updateAnfrageEinzelSlotStatus(verlierer.anfrage, ausloesenderSlotId, 'abgelehnt_slot_hoechstpreis');
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Anfrage ${updatedAnfrage.AnfrageID_Sprechend} unterliegt im Höchstpreisverfahren.`;
            }
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
        }
    }
    
    konflikt.markModified('zugewieseneAnfragen');
    konflikt.markModified('abgelehnteAnfragenHoechstpreis');
    
    return { anfragenToSave };
}


/**
 * Zählt die Anzahl der Anfragen, die in einem Kapazitätstopf aktiv um Kapazität konkurrieren.
 * @param {Document} topf - Ein voll populiertes Kapazitätstopf-Dokument.
 * (Benötigt: topf.ListeDerAnfragen -> mit .ZugewieseneSlots -> mit .slot.VerweisAufTopf)
 * @returns {number} Die Anzahl der aktiven Anfragen.
 */
function getAktiveAnfragenAnzahlFuerTopf(topf) {
    if (!topf || !topf.ListeDerAnfragen) return 0;

    let aktiveAnfragenAnzahl = 0;
    for (const anfrage of topf.ListeDerAnfragen) {
        if (!anfrage.ZugewieseneSlots) continue;

        const istAktivFuerDiesenTopf = anfrage.ZugewieseneSlots.some(zuweisung => {
            const gehoertZuDiesemTopf = zuweisung.slot && zuweisung.slot.VerweisAufTopf && zuweisung.slot.VerweisAufTopf.equals(topf._id);
            if (!gehoertZuDiesemTopf) return false;
            
            const istKeinAblehnungsstatus = !zuweisung.statusEinzelzuweisung.startsWith('abgelehnt_');
            return istKeinAblehnungsstatus;
        });

        if (istAktivFuerDiesenTopf) {
            aktiveAnfragenAnzahl++;
        }
    }
    return aktiveAnfragenAnzahl;
}

// @desc    Synchronisiert Konfliktstatus: Identifiziert Überbuchungen in Töpfen,
//          erstellt/aktualisiert Konfliktdokumente UND aktualisiert den Status
//          der betroffenen Slot-Zuweisungen in den Anfragen.
// @route   POST /api/konflikte/identifiziere-topf-konflikte
exports.identifiziereTopfKonflikte = async (req, res) => {
    try {
        const alleToepfe = await Kapazitaetstopf.find({})
            .populate({
                path: 'ListeDerAnfragen',
                select: '_id AnfrageID_Sprechend Status Entgelt ZugewieseneSlots EVU Zugnummer',
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf' // Wir brauchen den Verweis, um zu diesem Topf zurückzumappen
                }
            })
            .populate('ListeDerSlots', '_id SlotID_Sprechend'); // Dies kann für das Logging bleiben

        let neuErstellteKonfliktDokus = [];
        let aktualisierteUndGeoeffneteKonflikte = [];
        let unveraenderteBestehendeKonflikte = [];
        let autoGeloesteKonflikte = []; // Um aufzulisten, welche Konflikte sich von selbst gelöst haben
        let toepfeOhneKonflikt = [];

        let anfragenToSave = new Map();

        for (const topf of alleToepfe) {
            // --- Intelligente Zählung der Belegung des Topfes ---
            let aktiveAnfragenAnzahl = getAktiveAnfragenAnzahlFuerTopf(topf);

            const istUeberbucht = aktiveAnfragenAnzahl > topf.maxKapazitaet;

            if (istUeberbucht) {
                console.log(`Konflikt in Topf ${topf.TopfID || topf._id}: ${aktiveAnfragenAnzahl} Anfragen > maxKap ${topf.maxKapazitaet}`);

                // 1. Konfliktdokument erstellen oder aktualisieren
                let konfliktDoku = await KonfliktDokumentation.findOne({
                    ausloesenderKapazitaetstopf: topf._id
                }).sort({ updatedAt: -1 });

                const aktuelleAnfragenAmTopfIds = topf.ListeDerAnfragen.map(a => a._id);

                if (konfliktDoku) {
                    const gespeicherteAnfragenImKonfliktIds = konfliktDoku.beteiligteAnfragen;
                    if (!sindObjectIdArraysGleich(aktuelleAnfragenAmTopfIds, gespeicherteAnfragenImKonfliktIds)) {
                        //Anfragen im Topf haben sich verändert, Reset der Konfliktdoku und der zugehörigen Status der Anfragen für diesen Topf
                        console.log(`Konfliktdokument ${konfliktDoku._id} für Topf ${topf.TopfID}: Beteiligte Anfragen haben sich geändert. Wird zurückgesetzt.`);
                        konfliktDoku.beteiligteAnfragen = aktuelleAnfragenAmTopfIds;
                        konfliktDoku.konfliktTyp = 'KAPAZITAETSTOPF';
                        konfliktDoku.status = 'offen';
                        konfliktDoku.zugewieseneAnfragen = [];
                        konfliktDoku.abgelehnteAnfragenEntgeltvergleich = [];
                        konfliktDoku.abgelehnteAnfragenHoechstpreis = [];
                        konfliktDoku.ReihungEntgelt = [];
                        konfliktDoku.ListeGeboteHoechstpreis = [];
                        konfliktDoku.ListeAnfragenMitVerzicht = [];
                        konfliktDoku.ListeAnfragenVerschubKoordination = [];
                        konfliktDoku.abschlussdatum = undefined;
                        konfliktDoku.notizen = `${konfliktDoku.notizen || ''}\nKonflikt am ${new Date().toISOString()} neu bewertet/eröffnet aufgrund geänderter Anfragesituation. Ursprünglicher Status: ${konfliktDoku.status}.`;
                        
                        await konfliktDoku.save();
                        aktualisierteUndGeoeffneteKonflikte.push(konfliktDoku);
                        
                        // Alle Anfragen in diesem überbuchten Topf erhalten für die relevanten Slots den Status 'wartet_konflikt_topf'
                        for (const anfrage of topf.ListeDerAnfragen) {
                            await updateAnfrageSlotsStatusFuerTopf(anfrage, 'wartet_konflikt_topf', topf._id, konfliktDoku._id);
                            //finaler Topf-Status auch zurücksetzen
                            anfragenToSave.set(anfrage._id.toString(), anfrage);
                        }
                    } else { // Anfragen im Topf sind unverändert und er ist auch noch nicht gelöst, alles bleibt so wie es ist
                        console.log(`Konfliktdokument ${konfliktDoku._id} für Topf ${topf.TopfID}: Beteiligte Anfragen sind identisch. Status (${konfliktDoku.status}) bleibt erhalten.`);
                        unveraenderteBestehendeKonflikte.push(konfliktDoku);
                    }
                } else { // Topf ist überbucht aber es gibt noch keine Konfliktdoku --> neu initial anlegen
                    const neuesKonfliktDoku = new KonfliktDokumentation({
                        beteiligteAnfragen: aktuelleAnfragenAmTopfIds,
                        ausloesenderKapazitaetstopf: topf._id,
                        konfliktTyp: 'KAPAZITAETSTOPF',
                        status: 'offen',
                        notizen: `Automatisch erstellter Konflikt für Kapazitätstopf ${topf.TopfID || topf._id} am ${new Date().toISOString()}. ${topf.ListeDerAnfragen.length} Anfragen bei max. Kapazität von ${topf.maxKapazitaet}.`
                    });
                    await neuesKonfliktDoku.save();
                    neuErstellteKonfliktDokus.push(neuesKonfliktDoku);
                    
                    // Alle Anfragen in diesem überbuchten Topf erhalten für die relevanten Slots den Status 'wartet_konflikt_topf'
                    for (const anfrage of topf.ListeDerAnfragen) {
                        await updateAnfrageSlotsStatusFuerTopf(anfrage, 'wartet_konflikt_topf', topf._id, neuesKonfliktDoku._id);
                        anfragenToSave.set(anfrage._id.toString(), anfrage);
                    }

                    console.log(`Neues Konfliktdokument ${neuesKonfliktDoku._id} für Topf ${topf.TopfID} erstellt.`);
                }
            } else { // Topf ist nicht überbucht: Entweder er hatte keinen Konflikt oder wurde früher schon gelöst.
                toepfeOhneKonflikt.push(topf.TopfID || topf._id);

                let offenerKonflikt = await KonfliktDokumentation.findOne({
                    ausloesenderKapazitaetstopf: topf._id
                }).sort({ updatedAt: -1 });

                // Status der Anfragen aktualisieren, wenn der Konflikt noch nicht gelöst wurde                
                if(offenerKonflikt && offenerKonflikt.status !== 'geloest'){
                    // Alle Anfragen in diesem Topf sind für die Slots dieses Topfes "bestätigt" (auf Topf-Ebene)
                    for (const anfrage of topf.ListeDerAnfragen) {
                        await updateAnfrageSlotsStatusFuerTopf(anfrage, 'bestaetigt_topf', topf._id, offenerKonflikt._id);
                        anfragenToSave.set(anfrage._id.toString(), anfrage);
                    }
                    console.log(`Konflikt ${offenerKonflikt._id} für Topf ${topf.TopfID} wird automatisch gelöst, da keine Überbuchung mehr besteht.`);
                    offenerKonflikt.status = 'geloest';
                    offenerKonflikt.abschlussdatum = new Date();
                    offenerKonflikt.notizen = `${offenerKonflikt.notizen || ''}\nKonflikt am ${new Date().toISOString()} automatisch gelöst, da Kapazität nicht mehr überschritten.`;
                    // Die Anfragen, die noch im Topf sind, sind die "Gewinner"
                    offenerKonflikt.zugewieseneAnfragen = topf.ListeDerAnfragen.map(a => a._id);
                    await offenerKonflikt.save();
                    autoGeloesteKonflikte.push(offenerKonflikt);
                }
                // Wenn keine Konfliktdoku existiert, dann war der Topf nie überbucht und kann gelöst werden
                if(!offenerKonflikt){
                    for (const anfrage of topf.ListeDerAnfragen) {
                        // wenn die Anfrage schon in einem Slot-Konflikt ist oder final bestätigt oder abgeleht wurde,
                        // dann muss sie nicht mehr in den Status bestätigt_topf zurück gehen und kann übersprungen werden
                        const slotKonfliktOderSpaeter = [
                            'in_konfliktloesung_slot', 
                            'teilweise_final_bestaetigt',
                            'vollstaendig_final_bestaetigt',
                            'final_abgelehnt',
                            'fehlende_Plausi'
                        ];
                        if(slotKonfliktOderSpaeter.includes(anfrage.Status)) continue;
                        await updateAnfrageSlotsStatusFuerTopf(anfrage, 'bestaetigt_topf', topf._id, null);
                        anfragenToSave.set(anfrage._id.toString(), anfrage);
                    }
                    console.log(`Topf ${topf.TopfID} hatte keinen Konflikt und die Anfragen werden automatisch auf 'bestaetigt_topf' gesetzt, da keine Überbuchung besteht.`);

                }
            }
        }

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        // AM ENDE der Funktion: Rufe die Service-Funktion auf, um die Gruppen zu synchronisieren
        await konfliktService.aktualisiereKonfliktGruppen();
        

        res.status(200).json({
            message: 'Konfliktdetektion für Kapazitätstöpfe abgeschlossen.',
            neuErstellteKonflikte: neuErstellteKonfliktDokus.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            aktualisierteUndGeoeffneteKonflikte: aktualisierteUndGeoeffneteKonflikte.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            unveraenderteBestehendeKonflikte: unveraenderteBestehendeKonflikte.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            autoGeloesteKonflikte: autoGeloesteKonflikte.map(d => ({ id: d._id, topf: d.ausloesenderKapazitaetstopf, status: d.status })),
            toepfeOhneKonflikt: toepfeOhneKonflikt
        });

    } catch (error) {
        console.error('Fehler bei der Identifizierung von Topf-Konflikten:', error);
        res.status(500).json({ message: 'Serverfehler bei der Konfliktdetektion.' });
    }
};

// @desc    Synchronisiert Konfliktstatus: Identifiziert Überbuchungen in Slots,
//          erstellt/aktualisiert Konfliktdokumente UND aktualisiert den Status
//          der betroffenen Slot-Zuweisungen in den Anfragen.
// @route   POST /api/konflikte/identifiziere-slot-konflikte
exports.identifiziereSlotKonflikte = async (req, res) => {
    try {
        // 1. VORAUSSETZUNG PRÜFEN: Gibt es noch offene Topf-Konflikte?
        const anzahlOffenerTopfKonflikte = await KonfliktDokumentation.countDocuments({
            konfliktTyp: 'KAPAZITAETSTOPF',
            status: { $ne: 'geloest' }
        });

        if (anzahlOffenerTopfKonflikte > 0) {
            return res.status(409).json({ // 409 Conflict
                message: `Aktion nicht möglich. Es existieren noch ${anzahlOffenerTopfKonflikte} ungelöste Kapazitätstopf-Konflikte.`
            });
        }

        // 2. Lade alle Slots mit ihren zugewiesenen Anfragen
        const alleSlots = await Slot.find({ slotStrukturTyp: 'ELTERN' })
            .populate({
                path: 'zugewieseneAnfragen', // Anfragen, die diesen Slot wollen
                select: 'ZugewieseneSlots Status Zugnummer EVU', // Für die Status-Prüfung der Anfrage
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: '_id' // Nur die ID für den Vergleich
                }
            });

        let neuErstellteKonfliktDokus = [];
        let aktualisierteUndGeoeffneteKonflikte = [];
        let unveraenderteBestehendeKonflikte = [];
        let autoGeloesteKonflikte = []; // Um aufzulisten, welche Konflikte sich von selbst gelöst haben
        let slotsOhneKonflikt = [];

        // Definiere alle Status, die als "aktiv" für einen Slot-Konflikt gelten
        const aktiveSlotKonfliktStatusse = [
            'bestaetigt_topf',
            'bestaetigt_topf_entgelt',
            'bestaetigt_topf_hoechstpreis',
            'wartet_konflikt_slot',
            'wartet_entgeltentscheidung_slot',
            'wartet_hoechstpreis_slot',
            'bestaetigt_slot',
            'bestaetigt_slot_entgelt',
            'bestaetigt_slot_hoechstpreis',
            'bestaetigt_slot_nachgerueckt'
        ];

        const aktiveUndEntschiedeneSlotKonfliktStatusse = [
            'bestaetigt_topf',
            'bestaetigt_topf_entgelt',
            'bestaetigt_topf_hoechstpreis',
            'wartet_konflikt_slot',
            'wartet_entgeltentscheidung_slot',
            'wartet_hoechstpreis_slot',
            'bestaetigt_slot',
            'bestaetigt_slot_entgelt',
            'bestaetigt_slot_hoechstpreis',
            'bestaetigt_slot_nachgerueckt',
            'abgelehnt_slot_verzichtet',        
            'abgelehnt_slot_verschoben',        
            'abgelehnt_slot_entgelt',           
            'abgelehnt_slot_hoechstpreis',      
            'abgelehnt_slot_hoechstpreis_ungueltig',
            'abgelehnt_slot_hoechstpreis_kein_gebot'
        ];

        let anfragenToSave = new Map();

        for (const slot of alleSlots) {            
            // 3a. Ermittle "aktive" Anfragen für DIESEN Slot --> Zählung für die Überschreitung der Kapazität
            const aktiveAnfragenFuerSlot = slot.zugewieseneAnfragen.filter(anfrage => {
                // Finde die spezifische Zuweisung dieses Slots in der Anfrage
                const zuweisung = anfrage.ZugewieseneSlots.find(zs => zs.slot?._id.equals(slot._id));
                // Eine Anfrage ist aktiv, wenn ihr Einzelstatus für diesen Slot in der Liste der aktiven Status enthalten ist.
                return zuweisung && aktiveSlotKonfliktStatusse.includes(zuweisung.statusEinzelzuweisung);
            });

            // wenn es keine aktiven Anfragen gibt, dann gibt es auch nichts zu tun für den Slot
            if(aktiveAnfragenFuerSlot.length <=0) {
                slotsOhneKonflikt.push(slot.SlotID_Sprechend || slot._id);
                continue;
            }

            

            // 3b. Ermittle "aktive" und bereits entschiedenen Anfragen für DIESEN Slot --> Zählung für die Konfliktbeteiligung
            const aktiveUndEntschiedeneAnfragenFuerSlot = slot.zugewieseneAnfragen.filter(anfrage => {
                // Finde die spezifische Zuweisung dieses Slots in der Anfrage
                const zuweisung = anfrage.ZugewieseneSlots.find(zs => zs.slot?._id.equals(slot._id));
                // Eine Anfrage ist aktiv, wenn ihr Einzelstatus für diesen Slot in der Liste der aktiven Status enthalten ist.
                return zuweisung && aktiveUndEntschiedeneSlotKonfliktStatusse.includes(zuweisung.statusEinzelzuweisung);
            });
            
            let maxKapazitaetSlot = 1;
            //wenn es ein Nacht-Slot ist, dann werden alle Anfragen zugewiesen, d.h. wir haben immer ausreichend Kapazität für alle Anfragen
            if(slot.elternSlotTyp === "NACHT"){
                maxKapazitaetSlot = aktiveAnfragenFuerSlot.length + 1;
            }

            const istUeberbucht = aktiveAnfragenFuerSlot.length > maxKapazitaetSlot;

            if (istUeberbucht) {
                console.log(`Konflikt auf Slot ${slot.SlotID_Sprechend}: ${aktiveAnfragenFuerSlot.length} aktive Anfragen > maxKap ${maxKapazitaetSlot}`);

                // 4. Konfliktdokument erstellen/aktualisieren (gleiche Logik wie bei Töpfen)
                let konfliktDoku = await KonfliktDokumentation.findOne({ ausloesenderSlot: slot._id });
                const aktuelleBeteiligteAnfragenIds = aktiveUndEntschiedeneAnfragenFuerSlot.map(a => a._id);

                if (konfliktDoku) {
                    if (!sindObjectIdArraysGleich(aktuelleBeteiligteAnfragenIds, konfliktDoku.beteiligteAnfragen)) {
                        // Reset des Konflikts

                        console.log(`Konfliktdokument ${konfliktDoku._id} für Slot ${slot.SlotID_Sprechend}: Beteiligte Anfragen haben sich geändert. Wird zurückgesetzt.`);
                        konfliktDoku.beteiligteAnfragen = aktuelleBeteiligteAnfragenIds;
                        konfliktDoku.konfliktTyp = 'SLOT';
                        konfliktDoku.status = 'offen';
                        konfliktDoku.zugewieseneAnfragen = [];
                        konfliktDoku.abgelehnteAnfragenEntgeltvergleich = [];
                        konfliktDoku.abgelehnteAnfragenHoechstpreis = [];
                        konfliktDoku.ReihungEntgelt = [];
                        konfliktDoku.ListeGeboteHoechstpreis = [];
                        konfliktDoku.ListeAnfragenMitVerzicht = [];
                        konfliktDoku.ListeAnfragenVerschubKoordination = [];
                        konfliktDoku.abschlussdatum = undefined;
                        konfliktDoku.notizen = `${konfliktDoku.notizen || ''}\nKonflikt am ${new Date().toISOString()} neu bewertet/eröffnet aufgrund geänderter Anfragesituation. Ursprünglicher Status: ${konfliktDoku.status}.`;
                        

                        await konfliktDoku.save();
                        aktualisierteUndGeoeffneteKonflikte.push(konfliktDoku);
                        
                        // Alle Anfragen in diesem überbuchten Slot erhalten für die relevanten Slots den Status 'wartet_konflikt_slot'
                        for (const anfrage of aktiveUndEntschiedeneAnfragenFuerSlot) {
                            await updateAnfrageEinzelSlotStatus(anfrage, slot._id, 'wartet_konflikt_slot', konfliktDoku._id);
                            anfragenToSave.set(anfrage._id.toString(), anfrage);
                        }
                    }else { // Anfragen im Slot sind unverändert und er ist auch noch nicht gelöst, alles bleibt so wie es ist
                        console.log(`Konfliktdokument ${konfliktDoku._id} für Slot ${slot.SlotID_Sprechend || slot._id}: Beteiligte Anfragen sind identisch. Status (${konfliktDoku.status}) bleibt erhalten.`);
                        unveraenderteBestehendeKonflikte.push(konfliktDoku);
                    }
                } else {// Slot ist überbucht aber es gibt noch keine Konfliktdoku --> neu initial anlegen
                    const neuesKonfliktDoku = new KonfliktDokumentation({
                        konfliktTyp: 'SLOT',
                        beteiligteAnfragen: aktuelleBeteiligteAnfragenIds,
                        ausloesenderSlot: slot._id,
                        status: 'offen',
                        notizen: `Automatisch erstellter Konflikt für Slot ${slot.SlotID_Sprechend || slot._id} am ${new Date().toISOString()}. ${aktiveAnfragenFuerSlot.length} Anfragen bei max. Kapazität von 1.`
                    });
                    await neuesKonfliktDoku.save();
                    neuErstellteKonfliktDokus.push(neuesKonfliktDoku);

                    // Alle aktiven Anfragen in diesem überbuchten Slot erhalten für die relevanten Slots den Status 'wartet_konflikt_topf'
                    for (const anfrage of aktiveUndEntschiedeneAnfragenFuerSlot) {
                        await updateAnfrageEinzelSlotStatus(anfrage, slot._id, 'wartet_konflikt_slot', neuesKonfliktDoku._id);
                        anfragenToSave.set(anfrage._id.toString(), anfrage);
                    }

                    console.log(`Neues Konfliktdokument ${neuesKonfliktDoku._id} für Slot ${slot.SlotID_Sprechend || slot._id} erstellt. ${aktiveAnfragenFuerSlot.length} Anfragen bei max. Kapazität von 1.`);
                }   

            } else {// Slot ist nicht überbucht: Entweder er hatte keinen Konflikt oder wurde früher schon gelöst.
                slotsOhneKonflikt.push(slot.SlotID_Sprechend || slot._id);

                let offenerKonflikt = await KonfliktDokumentation.findOne({
                    ausloesenderSlot: slot._id
                }).sort({ updatedAt: -1 });

                // Status der Anfragen aktualisieren, wenn der Konflikt noch nicht gelöst wurde                
                if(offenerKonflikt && offenerKonflikt.status !== 'geloest'){
                    // Die eine aktive Anfrage in diesem Slot wird "bestätigt" (auf Slot-Ebene)
                    for (const anfrage of aktiveAnfragenFuerSlot) {
                        await updateAnfrageEinzelSlotStatus(anfrage, slot._id, 'bestaetigt_slot', offenerKonflikt._id);
                        anfragenToSave.set(anfrage._id.toString(), anfrage);
                    }
                    console.log(`Konflikt ${offenerKonflikt._id} für Slot ${slot.SlotID_Sprechend || slot._id} wird automatisch gelöst, da keine Überbuchung mehr besteht.`);
                    offenerKonflikt.status = 'geloest';
                    offenerKonflikt.abschlussdatum = new Date();
                    offenerKonflikt.notizen = `${offenerKonflikt.notizen || ''}\nKonflikt am ${new Date().toISOString()} automatisch gelöst, da Kapazität nicht mehr überschritten.`;
                    // Die Anfragen, die noch im Topf sind, sind die "Gewinner"
                    offenerKonflikt.zugewieseneAnfragen = aktiveAnfragenFuerSlot.map(a => a._id);
                    await offenerKonflikt.save();
                    autoGeloesteKonflikte.push(offenerKonflikt);
                }
                // Wenn keine Konfliktdoku existiert, dann war der Topf nie überbucht und kann gelöst werden
                if(!offenerKonflikt){
                    for (const anfrage of aktiveAnfragenFuerSlot) {
                        await updateAnfrageEinzelSlotStatus(anfrage, slot._id, 'bestaetigt_slot', null);
                        anfragenToSave.set(anfrage._id.toString(), anfrage);
                    }
                    console.log(`Slot ${slot.SlotID_Sprechend || slot._id} hatte keinen Konflikt und die Anfragen werden automatisch auf 'bestaetigt_slot' gesetzt, da keine Überbuchung besteht.`);

                }
            }
        }

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        // AM ENDE der Funktion: Rufe die Service-Funktion auf, um die Gruppen zu synchronisieren
        await konfliktService.aktualisiereKonfliktGruppen();

        res.status(200).json({ 
            message: 'Konfliktdetektion für Slots abgeschlossen.',
            neuErstellteKonflikte: neuErstellteKonfliktDokus.map(d => ({ id: d._id, slot: d.ausloesenderSlot, status: d.status })),
            aktualisierteUndGeoeffneteKonflikte: aktualisierteUndGeoeffneteKonflikte.map(d => ({ id: d._id, slot: d.ausloesenderSlot, status: d.status })),
            unveraenderteBestehendeKonflikte: unveraenderteBestehendeKonflikte.map(d => ({ id: d._id, slot: d.ausloesenderSlot, status: d.status })),
            autoGeloesteKonflikte: autoGeloesteKonflikte.map(d => ({ id: d._id, slot: d.ausloesenderSlot, status: d.status })),
            slotsOhneKonflikt: slotsOhneKonflikt
         });

    } catch (error) {
        console.error('Fehler bei der Identifizierung von Slot-Konflikten:', error);
        res.status(500).json({ message: 'Serverfehler bei der Slot-Konflikterkennung.' });
    }
};


// @desc    Ruft alle Konfliktdokumentationen ab
// @route   GET /api/konflikte
exports.getAllKonflikte = async (req, res) => {
    try {
        const queryParams = req.query;
        let filter = {};
        let sortOptions = { status: 1, createdAt: -1 }; // Neueste zuerst als Standard

        if (queryParams.status) {
            filter.status = queryParams.status;
        }
        if (queryParams.ausloesenderKapazitaetstopf) {
            if (mongoose.Types.ObjectId.isValid(queryParams.ausloesenderKapazitaetstopf)) {
                filter.ausloesenderKapazitaetstopf = queryParams.ausloesenderKapazitaetstopf;
            } else {
                // Versuche, nach TopfID (sprechend) zu filtern, erfordert zusätzlichen Schritt
                const topf = await Kapazitaetstopf.findOne({ TopfID: queryParams.ausloesenderKapazitaetstopf }).select('_id');
                if (topf) {
                    filter.ausloesenderKapazitaetstopf = topf._id;
                } else {
                    // Wenn TopfID nicht gefunden, leeres Ergebnis für diesen Filter zurückgeben
                    return res.status(200).json({ message: 'Keine Konflikte für die angegebene TopfID gefunden (TopfID nicht existent).', data: [], totalCount: 0 });
                }
            }
        }

        if (queryParams.sortBy) {
            const parts = queryParams.sortBy.split(':');
            sortOptions = {};
            sortOptions[parts[0]] = parts[1] === 'desc' ? -1 : 1;
        }
        
        const page = parseInt(queryParams.page, 10) || 1;
        const limit = parseInt(queryParams.limit, 10) || 10;
        const skip = (page - 1) * limit;

        // 1. Lade die Konfliktdokumente für die aktuelle Seite
        const konflikte = await KonfliktDokumentation.find(filter)
            .select('-__v') // Schließe das __v Feld aus
            .populate({ // NEU: Populiere BEIDE möglichen Auslöser-Felder
                path: 'ausloesenderKapazitaetstopf',
                select: 'TopfID Verkehrsart maxKapazitaet'
            })
            .populate({ // NEU: Populiere BEIDE möglichen Auslöser-Felder
                path: 'ausloesenderSlot',
                select: 'SlotID_Sprechend Verkehrsart' // Holen wir auch hier die VA für eine einheitliche Anzeige
            })
            .sort(sortOptions)
            .skip(skip)
            .limit(limit)
            .lean(); // .lean() für reine JS-Objekte, die wir anreichern können

        const totalKonflikte = await KonfliktDokumentation.countDocuments(filter);
        

        // 2. Finde für die abgerufenen Konflikte die zugehörige Gruppenzuordnung
        const konfliktIds = konflikte.map(k => k._id);
        const gruppen = await KonfliktGruppe.find({ konflikteInGruppe: { $in: konfliktIds } }).select('_id konflikteInGruppe');
        
        // Erstelle eine Map für schnellen Zugriff: konfliktId -> gruppenId
        const konfliktZuGruppeMap = new Map();
        gruppen.forEach(g => {
            g.konflikteInGruppe.forEach(kId => {
                konfliktZuGruppeMap.set(kId.toString(), g._id.toString());
            });
        });

        // 3. Reichere jedes Konflikt-Objekt mit den finalen Daten an
        const angereicherteKonflikte = konflikte.map(konflikt => {
            const summeAbgelehnt = 
                (konflikt.ListeAnfragenMitVerzicht?.length || 0) +
                (konflikt.ListeAnfragenVerschubKoordination?.length || 0) +
                (konflikt.abgelehnteAnfragenEntgeltvergleich?.length || 0) +
                (konflikt.abgelehnteAnfragenHoechstpreis?.length || 0);

            return {
                ...konflikt,
                gruppenId: konfliktZuGruppeMap.get(konflikt._id.toString()) || null, // Füge die Gruppen-ID hinzu
                statistik: {
                    anzahlBeteiligter: konflikt.beteiligteAnfragen?.length || 0,
                    anzahlZugewiesener: konflikt.zugewieseneAnfragen?.length || 0,
                    anzahlAbgelehnter: summeAbgelehnt
                }
            };
        });


        res.status(200).json({
            message: 'Konfliktdokumentationen erfolgreich abgerufen.',
            data: angereicherteKonflikte,
            currentPage: page,
            totalPages: Math.ceil(totalKonflikte / limit),
            totalCount: totalKonflikte
        });

    } catch (error) {
        console.error('Fehler beim Abrufen aller Konfliktdokumentationen:', error);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Konfliktdokumentationen.' });
    }
};

// @desc    Ruft eine spezifische Konfliktdokumentation ab
// @route   GET /api/konflikte/:konfliktId
exports.getKonfliktById = async (req, res) => {
    try {
        const konfliktId = req.params.konfliktId;

        if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
            return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
        }

        // Schritt 1: Lade das Konfliktdokument und seine direkten Referenzen
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            // Stufe 1: Populiere den auslösenden Kapazitätstopf (falls vorhanden)
            .populate({
                path: 'ausloesenderKapazitaetstopf',
                // Stufe 2: Innerhalb des Topfes, populiere dessen Liste von Slots
                populate: {
                    path: 'ListeDerSlots',
                    model: 'Slot',
                    // Lade die Felder, die wir in der Slot-Tabelle anzeigen wollen
                    select: 'SlotID_Sprechend Linienbezeichnung Abschnitt zugewieseneAnfragen'
                }
            })
            // Populiere den auslösenden Slot (falls vorhanden)
            .populate('ausloesenderSlot', 'SlotID_Sprechend von bis Abschnitt Linienbezeichnung zugewieseneAnfragen')
            .populate([
                { path: 'beteiligteAnfragen', select: 'AnfrageID_Sprechend EVU Zugnummer Status Verkehrsart Entgelt' },
                { path: 'zugewieseneAnfragen', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'abgelehnteAnfragenEntgeltvergleich', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'abgelehnteAnfragenHoechstpreis', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'ListeAnfragenMitVerzicht', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'ListeAnfragenVerschubKoordination.anfrage', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'abgelehnteAnfragenMarktanteil', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' }
            ])
            .lean();


        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        } 

        // Schritt 2: - Finde die übergeordnete Konfliktgruppe
        const gruppe = await KonfliktGruppe.findOne({ 
            konflikteInGruppe: konflikt._id 
        }).select('_id'); // Wir brauchen nur die ID der Gruppe

        // Schritt 3: Reichere die Antwortdaten an
        const responseData = {
            konflikt: konflikt,
            gruppenId: gruppe ? gruppe._id : null // Füge die gefundene Gruppen-ID hinzu (oder null)
        };

        res.status(200).json({
            message: 'Konfliktdokumentation erfolgreich abgerufen.',
            data: responseData
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Konfliktdokumentation anhand der ID:', error);
        if (error.name === 'CastError') { // Sollte durch isValid oben abgefangen werden
            return res.status(400).json({ message: 'Ungültiges ID-Format.' });
        }
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Konfliktdokumentation.' });
    }
};

// Phase 1 Controller-Funktion
// @desc    Verarbeitet Verzichte/Verschiebungen und löst Topf-Konflikt ggf. automatisch
// @route   PUT /api/konflikte/:konfliktId/verzicht-verschub
exports.verarbeiteVerzichtVerschub = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeAnfragenMitVerzicht, ListeAnfragenVerschubKoordination, notizen, notizenUpdateMode } = req.body;

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }

    //console.log(`konfliktId ${konfliktId}, ListeAnfragenMitVerzicht ${ListeAnfragenMitVerzicht}`);

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
        .populate({
                path: 'ausloesenderKapazitaetstopf',
                select: 'maxKapazitaet TopfID _id' // Benötigt für den Vergleich
            })
            .populate({
                path: 'beteiligteAnfragen',
                // Wähle alle Felder, die für die Logik und spätere Updates benötigt werden
                select: 'AnfrageID_Sprechend EVU Entgelt Status ZugewieseneSlots _id Zugnummer', 
                // Füge eine verschachtelte Population hinzu, um die Details der zugewiesenen Slots zu bekommen
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf' // Wichtig für den Vergleich in der Helferfunktion
                }
            });

        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (konflikt.konfliktTyp !== 'KAPAZITAETSTOPF') return res.status(400).json({ message: 'Dieser Endpunkt ist nur für Topf-Konflikte.' });
       
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }
        // Erlaube Bearbeitung nur, wenn Status z.B. 'offen' oder 'in_bearbeitung' (oder spezifischer vorheriger Schritt)
        if (!['offen', 'in_bearbeitung'].includes(konflikt.status)) {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und kann nicht über diesen Endpunkt bearbeitet werden.` });
        }

        // Rufe die zentrale Service-Funktion auf        
        const { anfragenToSave } = resolveVerzichtVerschubForSingleTopfConflict(
            konflikt,
            ListeAnfragenMitVerzicht,
            ListeAnfragenVerschubKoordination
        );       
        
        // Allgemeine Notizen aus dem Request Body verarbeiten
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const notizPrefix = `\nVerarbeitung Verzicht für Topf-Konflikt am ${new Date().toLocaleString()}: `;
        if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
        else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Kapazität weiterhin überschritten. Entgeltvergleich erforderlich.`;

        const aktualisierterKonflikt = await konflikt.save(); // Speichere das Konfliktdokument

        

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            //console.log(`anfragenToSave ${anfragenToSave}, anfrageDoc ${anfrageDoc}`);
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Verzicht/Verschub für Topf-Konflikt ${konflikt.TopfID || konflikt._id} verarbeitet. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/verzicht-verschub:`, error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Ungültige Daten im Request Body (z.B. ObjectId Format).', errorDetails: error.message });
        }
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung von Verzicht/Verschub.' });
    }
};

// --- Controller für EINZELNEN Slot-Konflikt ---
// @desc    Phase 1: Verarbeitet Verzicht/Verschub für einen einzelnen Slot-Konflikt
// @route   PUT /api/konflikte/slot/:konfliktId/verzicht-verschub
exports.verarbeiteEinzelSlotVerzichtVerschub = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeAnfragenMitVerzicht, ListeAnfragenVerschubKoordination, notizen, notizenUpdateMode } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('beteiligteAnfragen', '_id Status Entgelt ZugewieseneSlots Zugnummer EVU')
            .populate('ausloesenderSlot', '_id SlotID_Sprechend');

        if (!konflikt) return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        if (konflikt.konfliktTyp !== 'SLOT') return res.status(400).json({ message: 'Dieser Endpunkt ist nur für Slot-Konflikte.' });
        if (!['offen', 'in_bearbeitung'].includes(konflikt.status)) {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und kann nicht bearbeitet werden.` });
        }

        // Rufe die zentrale Service-Funktion auf
        const { anfragenToSave } = resolveVerzichtVerschubForSingleSlotConflict(
            konflikt,
            ListeAnfragenMitVerzicht,
            ListeAnfragenVerschubKoordination
        );
        
        // Notizen für den Einzelkonflikt aktualisieren
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const notizPrefix = `\nVerarbeitung Verzicht für Slot-Konflikt am ${new Date().toLocaleString()}: `;
        if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
        else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt besteht weiterhin. Entgeltvergleich erforderlich.`;

        const aktualisierterKonflikt = await konflikt.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Verzicht/Verschub für Slot-Konflikt ${aktualisierterKonflikt._id} verarbeitet. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/slot/${konfliktId}/verzicht-verschub:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung des Slot-Konflikts.' });
    }
};

// Phase 2 Controller-Funktion
// @desc    Führt den Entgeltvergleich für einen einzelnen Topf-Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/entgeltvergleich
exports.fuehreEntgeltvergleichDurch = async (req, res) => {    
    const { konfliktId } = req.params;
    const { notizen, notizenUpdateMode, evuReihungen } = req.body || {}; // Nur Notizen werden optional erwartet

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
        .populate({
                path: 'ausloesenderKapazitaetstopf',
                select: 'maxKapazitaet TopfID _id ListeDerSlots' // Benötigt für den Vergleich
            })
            .populate({
                path: 'beteiligteAnfragen',
                // Wähle alle Felder, die für die Logik und spätere Updates benötigt werden
                select: 'AnfrageID_Sprechend EVU Entgelt Status ZugewieseneSlots _id Zugnummer', 
                // Füge eine verschachtelte Population hinzu, um die Details der zugewiesenen Slots zu bekommen
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf' // Wichtig für den Vergleich in der Helferfunktion
                }
            });
        

        if (!konflikt || konflikt.konfliktTyp !== 'KAPAZITAETSTOPF') {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }

        // Erlaube Bearbeitung nur, wenn Status passend ist (z.B. nach Verzicht/Verschub oder initial offen)
        if (!['offen', 'in_bearbeitung_entgelt', 'in_bearbeitung'].includes(konflikt.status)) {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und der Entgeltvergleich kann nicht (erneut) durchgeführt werden, ohne ihn ggf. zurückzusetzen.` });
        }

        // Rufe die zentrale Service-Funktion auf
        const { anfragenToSave } = resolveEntgeltvergleichForSingleTopfConflict(konflikt, evuReihungen);
       

        //#######################################


        // Allgemeine Notizen aus dem Request Body verarbeiten
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const notizPrefix = `\nEntgeltvergleich Topf-Konflikt am ${new Date().toLocaleString()}: `;
        if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
        else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Kein eindeutiger Gewinner. Höchstpreisverfahren erforderlich.`;

        const aktualisierterKonflikt = await konflikt.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            //console.log(anfrageDoc);
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Entgeltvergleich für Topf-Konflikt ${konflikt.TopfID || konflikt._id} durchgeführt. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/entgeltvergleich:`, error);
        // ... (Standardfehlerbehandlung)
        res.status(500).json({ message: 'Serverfehler beim Durchführen des Entgeltvergleichs.' });
    }
};

// Phase 2 Controller-Funktion
// @desc    Führt den Entgeltvergleich für einen EINZELNEN Slot-Konflikt durch
// @route   PUT /api/konflikte/slot/:konfliktId/entgeltvergleich
exports.fuehreEinzelSlotEntgeltvergleichDurch = async (req, res) => {
    const { konfliktId } = req.params;
    const { notizen, notizenUpdateMode } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });


    try {  
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate({
                path: 'ausloesenderSlot',
                select: '_id SlotID_Sprechend'
            })
            .populate({
                path: 'beteiligteAnfragen',
                select: 'AnfrageID_Sprechend EVU Entgelt Status ZugewieseneSlots _id Zugnummer',
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: '_id' // Wir brauchen nur die ID für den Vergleich in der Helferfunktion
                }
            });

        if (!konflikt || konflikt.konfliktTyp !== 'SLOT') {
            return res.status(404).json({ message: 'Slot-Konfliktdokumentation nicht gefunden.' });
        }
        if (!['in_bearbeitung_entgelt'].includes(konflikt.status)) { // Passender Status
            return res.status(400).json({ message: `Konflikt hat Status '${konflikt.status}' und kann nicht bearbeitet werden.` });
        }

        const { anfragenToSave } = resolveEntgeltvergleichForSingleSlotConflict(konflikt);
        
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }


        const notizPrefix = `\nEntgeltvergleich Slot-Konflikt am ${new Date().toLocaleString()}: `;
        if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
        else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Kein eindeutiger Gewinner. Höchstpreisverfahren erforderlich.`;
        
        const aktualisierterKonflikt = await konflikt.save();

        for (const anfrageDoc of anfragenToSave.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Entgeltvergleich für Slot-Konflikt ${konflikt.TopfID || konflikt._id} durchgeführt. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) { 
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/entgeltvergleich:`, error);
        // ... (Standardfehlerbehandlung)
        res.status(500).json({ message: 'Serverfehler beim Durchführen des Entgeltvergleichs.' });
    }
};

// Phase 3 Controller-Funktion
// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens für einen einzelnen Topf-Konflikt
// @route   PUT /api/konflikte/:konfliktId/hoechstpreis-ergebnis
exports.verarbeiteHoechstpreisErgebnis = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeGeboteHoechstpreis, notizen, notizenUpdateMode } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }
    if (!ListeGeboteHoechstpreis || !Array.isArray(ListeGeboteHoechstpreis)) {
        return res.status(400).json({ message: 'ListeGeboteHoechstpreis (Array) muss im Request Body vorhanden sein.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
        .populate({
                path: 'ausloesenderKapazitaetstopf',
                select: 'maxKapazitaet TopfID _id ListeDerSlots' // Benötigt für den Vergleich
            })
            .populate({
                path: 'beteiligteAnfragen',
                // Wähle alle Felder, die für die Logik und spätere Updates benötigt werden
                select: 'AnfrageID_Sprechend EVU Entgelt Status ZugewieseneSlots _id Zugnummer', 
                // Füge eine verschachtelte Population hinzu, um die Details der zugewiesenen Slots zu bekommen
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf' // Wichtig für den Vergleich in der Helferfunktion
                }
            });
        

        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (konflikt.status !== 'in_bearbeitung_hoechstpreis') {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und erwartet keine Höchstpreis-Ergebnisse.` });
        }
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }

        // Rufe die zentrale Service-Funktion auf
        const { anfragenToSave } = resolveHoechstpreisForSingleTopfConflict(konflikt, ListeGeboteHoechstpreis);


        //#######################################

        

        //###########################################

        // Allgemeine Notizen aus dem Request Body verarbeiten
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const notizPrefix = `\nHöchstpreisrunde Topf-Konflikt am ${new Date().toLocaleString()}: `;
        if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
        else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Erneuter Gleichstand. Nächste Runde erforderlich.`;

        const aktualisierterKonflikt = await konflikt.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Höchstpreisverfahren für Konflikt ${konflikt.TopfID || konflikt._id} verarbeitet. Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/hoechstpreis-ergebnis:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung des Höchstpreis-Ergebnisses.' });
    }
};

// --- Controller für EINZELNEN Slot-Konflikt (Höchstpreis) ---
// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens für einen einzelnen Slot-Konflikt
// @route   PUT /api/konflikte/slot/:konfliktId/hoechstpreis-ergebnis
exports.verarbeiteEinzelSlotHoechstpreisErgebnis = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeGeboteHoechstpreis, notizen, notizenUpdateMode } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    if (!ListeGeboteHoechstpreis || !Array.isArray(ListeGeboteHoechstpreis)) return res.status(400).json({ message: 'ListeGeboteHoechstpreis ist erforderlich.' });

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId).populate({
            path: 'beteiligteAnfragen',
            select: 'AnfrageID_Sprechend EVU Entgelt Status ZugewieseneSlots Zugnummer',
            populate: { path: 'ZugewieseneSlots.slot', select: '_id' }
        }).populate('ausloesenderSlot', '_id');
        
        if (!konflikt || konflikt.konfliktTyp !== 'SLOT') return res.status(404).json({ message: 'Slot-Konfliktdokumentation nicht gefunden.' });
        if (konflikt.status !== 'in_bearbeitung_hoechstpreis') return res.status(400).json({ message: `Konflikt hat Status '${konflikt.status}' und erwartet keine Höchstpreis-Ergebnisse.` });

        // Rufe die zentrale Service-Funktion auf
        const { anfragenToSave } = resolveHoechstpreisForSingleSlotConflict(konflikt, ListeGeboteHoechstpreis);
        
        // Notizen für den Einzelkonflikt aktualisieren
        if (notizen !== undefined) {
            const notizPrefix = `Ergänzung vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && konflikt.notizen) {
                konflikt.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                konflikt.notizen = (konflikt.notizen && notizenUpdateMode === 'append' ? konflikt.notizen + "\n---\n" : "") + notizPrefix + notizen;
            }
            konflikt.markModified('notizen');
        }

        const notizPrefix = `\nHöchstpreisrunde Slot-Konflikt am ${new Date().toLocaleString()}: `;
        if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
        else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Erneuter Gleichstand. Nächste Runde erforderlich.`;

        const aktualisierterKonflikt = await konflikt.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Höchstpreisverfahren für Slot-Konflikt ${aktualisierterKonflikt._id} verarbeitet.`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/slot/${konfliktId}/hoechstpreis-ergebnis:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung des Höchstpreis-Ergebnisses.' });
    }
};

// @desc    Ruft alle persistierten Topf-Konfliktgruppen und Slot-Konfliktgruppen ab
// @route   GET /api/konflikte/gruppen
exports.identifiziereKonfliktGruppen = async (req, res) => {
    try {        
        // Filtere optional nach Status der Gruppe, z.B. alle, die nicht gelöst sind
        //const filter = { status: { $ne: 'vollstaendig_geloest' } };        

            const gruppen = await KonfliktGruppe.find()
            .populate('beteiligteAnfragen', 'AnfrageID_Sprechend EVU Entgelt Verkehrsart')
            .populate({
                path: 'konflikteInGruppe',
                select: 'status konfliktTyp ausloesenderKapazitaetstopf ausloesenderSlot',
                // HIER DIE ANPASSUNG: Wir populieren jetzt BEIDE möglichen Auslöser
                populate: [
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: 'TopfID maxKapazitaet'
                    },
                    {
                        path: 'ausloesenderSlot',
                        select: 'SlotID_Sprechend von bis'
                    }
                ]
            })
            .sort({ updatedAt: -1 }); // Die zuletzt bearbeiteten Gruppen zuerst
            
            

        res.status(200).json({
            message: `${gruppen.length} aktive Konfliktgruppen gefunden.`,
            data: gruppen
        });

    } catch (error) {
        console.error('Fehler beim Abrufen der Konfliktgruppen:', error);
        res.status(500).json({ message: 'Serverfehler beim Abrufen der Gruppen.' });
    }
};

// --- Controller für eine GRUPPE von Topf-Konflikten ---
// @desc    Verarbeitet Verzichte/Verschiebungen für eine ganze Topf-Konfliktgruppe
// @route   PUT /api/konflikte/gruppen/:gruppenId/verzicht-verschub
exports.verarbeiteGruppenVerzichtVerschub = async (req, res) => {
    const { gruppenId } = req.params;
    const { ListeAnfragenMitVerzicht, ListeAnfragenVerschubKoordination, notizen, notizenUpdateMode } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    }

    try {
        // 1. Lade die Gruppe und alle zugehörigen Daten   
            const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'konflikteInGruppe', // Population der Konfliktdokumente in der Gruppe
                populate: [ // Array, um mehrere Felder innerhalb der Konfliktdokumente zu populieren
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: 'maxKapazitaet TopfID _id'
                    },
                    {
                        path: 'beteiligteAnfragen', // Populiere die Anfragen INNERHALB jedes Einzelkonflikts
                        select: 'ZugewieseneSlots Status _id Entgelt EVU Zugnummer AnfrageID_Sprechend',
                        populate: { // Und gehe noch eine Ebene tiefer zu den Slots
                            path: 'ZugewieseneSlots.slot',
                            model: 'Slot',
                            select: 'VerweisAufTopf'
                        }
                    }
                ]
            });

        if (!gruppe) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
        }
        if (!['offen', 'in_bearbeitung_verzicht'].includes(gruppe.status)) {
             return res.status(400).json({ message: `Konfliktgruppe ist im Status '${gruppe.status}' und kann nicht bearbeitet werden.` });
        }

        let alleAnfragenZumSpeichern = new Map();
        let anzahlOffenerKonflikte = 0;

        // Iteriere durch jeden einzelnen Konflikt der Gruppe
        for (const konflikt of gruppe.konflikteInGruppe) {
            if (konflikt.konfliktTyp !== 'KAPAZITAETSTOPF') continue; // Überspringe fälschlicherweise zugeordnete Slot-Konflikte

            // Rufe die zentrale Service-Funktion auf

            //console.log(konflikt);

            const { anfragenToSave } = resolveVerzichtVerschubForSingleTopfConflict(
                konflikt,
                ListeAnfragenMitVerzicht,
                ListeAnfragenVerschubKoordination
            );

            // Füge modifizierte Anfragen zur Map hinzu (Duplikate werden durch Map-Struktur vermieden)
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));

            if (konflikt.status !== 'geloest') {
                anzahlOffenerKonflikte++;
            }

            const notizPrefix = `\nVerarbeitung Verzicht für Topf-Konflikt am ${new Date().toLocaleString()}: `;
            if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
            else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Kapazität weiterhin überschritten. Entgeltvergleich erforderlich.`;

             await konflikt.save(); // Speichere die Änderungen am einzelnen Konfliktdokument
        }

        // Aktualisiere den Gesamtstatus der Gruppe
        if (anzahlOffenerKonflikte > 0) {
            gruppe.status = 'in_bearbeitung_entgelt'; //es geht dann weiter mit dem Engeltvergleich
        } else {
            gruppe.status = 'vollstaendig_geloest';
        }

        // Notizen für die Gruppe
        if (notizen !== undefined) {
             const notizPrefix = `Gruppen-Notiz vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && gruppe.notizen) {
                gruppe.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                gruppe.notizen = notizPrefix + notizen;
            }
        }
        
        const aktualisierteGruppe = await gruppe.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of alleAnfragenZumSpeichern.values()) {
            //console.log(`anfrageDoc vor Statusupdate ${anfrageDoc}`);
             await anfrageDoc.updateGesamtStatus();
             //console.log(`anfrageDoc nach Statusupdate ${anfrageDoc}`);
             await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Verzicht/Verschub für Topf-Konfliktgruppe ${gruppe._id} verarbeitet.`,
            data: {
                gruppe: aktualisierteGruppe,
                zusammenfassung: {
                    anzahlKonflikteInGruppe: gruppe.konflikteInGruppe.length,
                    davonGeloest: gruppe.konflikteInGruppe.length - anzahlOffenerKonflikte,
                    davonOffen: anzahlOffenerKonflikte
                }
            }
        });
    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/gruppen/${gruppenId}/verzicht-verschub:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung der Konfliktgruppe.' });
    }
};

// --- Controller für eine GRUPPE von Slot-Konflikten ---
// @desc    Phase 1: Verarbeitet Verzicht/Verschub für eine ganze Slot-Konfliktgruppe
// @route   PUT /api/konflikte/slot-gruppen/:gruppenId/verzicht-verschub
exports.verarbeiteSlotGruppenVerzichtVerschub = async (req, res) => {
    const { gruppenId } = req.params;
    const { ListeAnfragenMitVerzicht, ListeAnfragenVerschubKoordination, notizen, notizenUpdateMode } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });

    try {
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'konflikteInGruppe', // Population der Konfliktdokumente in der Gruppe
                populate: [ // Array, um mehrere Felder innerhalb der Konfliktdokumente zu populieren
                    {
                        path: 'ausloesenderSlot',
                        select: 'TopfID _id'
                    },
                    {
                        path: 'beteiligteAnfragen', // Populiere die Anfragen INNERHALB jedes Einzelkonflikts
                        select: 'ZugewieseneSlots Status _id Entgelt EVU Zugnummer AnfrageID_Sprechend',
                        populate: { // Und gehe noch eine Ebene tiefer zu den Slots
                            path: 'ZugewieseneSlots.slot',
                            model: 'Slot',
                            select: 'VerweisAufTopf'
                        }
                    }
                ]
            });
        if (!gruppe) return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
        if (!['offen', 'in_bearbeitung_verzicht'].includes(gruppe.status)) {
             return res.status(400).json({ message: `Konfliktgruppe ist im Status '${gruppe.status}' und kann nicht bearbeitet werden.` });
        }

        let alleAnfragenZumSpeichern = new Map();
        let anzahlOffenerKonflikte = 0;

        // Iteriere durch jeden einzelnen Konflikt der Gruppe
        for (const konflikt of gruppe.konflikteInGruppe) {
            if (konflikt.konfliktTyp !== 'SLOT') continue; // Überspringe fälschlicherweise zugeordnete Topf-Konflikte

            const { anfragenToSave } = resolveVerzichtVerschubForSingleSlotConflict(
                konflikt,
                ListeAnfragenMitVerzicht,
                ListeAnfragenVerschubKoordination
            );
            
            // Füge modifizierte Anfragen zur Map hinzu (Duplikate werden durch Map-Struktur vermieden)
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));
            if (konflikt.status !== 'geloest') anzahlOffenerKonflikte++;

            const notizPrefix = `\nVerarbeitung Verzicht für Slot-Konflikt am ${new Date().toLocaleString()}: `;
            if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
            else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt besteht weiterhin. Entgeltvergleich erforderlich.`;
            
            await konflikt.save(); // Speichere die Änderungen am einzelnen Konfliktdokument
        }

        // Aktualisiere den Gesamtstatus der Gruppe
        if (anzahlOffenerKonflikte > 0) {
            gruppe.status = 'in_bearbeitung_entgelt'; //es geht dann weiter mit dem Engeltvergleich
        } else {
            gruppe.status = 'vollstaendig_geloest';
        }

        // Notizen für die Gruppe
        if (notizen !== undefined) {
             const notizPrefix = `Gruppen-Notiz vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && gruppe.notizen) {
                gruppe.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                gruppe.notizen = notizPrefix + notizen;
            }
        }

        const aktualisierteGruppe = await gruppe.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of alleAnfragenZumSpeichern.values()) {
            //console.log(`anfrageDoc vor Statusupdate ${anfrageDoc}`);
             await anfrageDoc.updateGesamtStatus();
             //console.log(`anfrageDoc nach Statusupdate ${anfrageDoc}`);
             await anfrageDoc.save();
        }        

        res.status(200).json({
            message: `Verzicht/Verschub für Slot-Konfliktgruppe ${gruppe._id} verarbeitet.`,
            data: {
                gruppe: aktualisierteGruppe,
                zusammenfassung: {
                    anzahlKonflikteInGruppe: gruppe.konflikteInGruppe.length,
                    davonGeloest: gruppe.konflikteInGruppe.length - anzahlOffenerKonflikte,
                    davonOffen: anzahlOffenerKonflikte
                }
            }
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/slot-gruppen/${gruppenId}/verzicht-verschub:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung der Slot-Konfliktgruppe.' });
    }
};

// @desc    Führt den Entgeltvergleich für eine GANZE Topf-Konfliktgruppe durch
// @route   PUT /api/konflikte/gruppen/:gruppenId/entgeltvergleich
exports.fuehreGruppenEntgeltvergleichDurch = async (req, res) => {
    const { gruppenId } = req.params;
    const { notizen, notizenUpdateMode, evuReihungen } = req.body || {};
    
    // ... (Validierung und Laden der Gruppe wie in verarbeiteGruppenVerzichtVerschub) ...
    if (!mongoose.Types.ObjectId.isValid(gruppenId)) return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    
    // 1. Lade die Gruppe und alle zugehörigen Daten mit korrektem verschachteltem Populate
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'beteiligteAnfragen', // Optional, aber gut für direkten Zugriff auf die gemeinsamen Anfragen
                select: '_id Status Entgelt AnfrageID_Sprechend EVU Zugnummer'
            })
            .populate({
                path: 'konflikteInGruppe', // Population der Konfliktdokumente in der Gruppe
                populate: [ // NEU: Array, um mehrere Felder innerhalb der Konfliktdokumente zu populieren
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: 'maxKapazitaet TopfID _id ListeDerSlots'
                    },
                    {
                        path: 'beteiligteAnfragen', // JETZT wird auch dieses Feld in jedem Einzelkonflikt populiert
                        select: '_id Status Entgelt AnfrageID_Sprechend EVU Zugnummer ZugewieseneSlots',
                        populate: { // ...und innerhalb dieser Zuweisungen...
                            path: 'ZugewieseneSlots.slot',
                            model: 'Slot',
                            select: 'VerweisAufTopf' // ...den Verweis auf den Topf des Slots.
                        }
                    }
                ]
            });  
        
    if (!gruppe) return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });

    try {
        let alleAnfragenZumSpeichern = new Map();
        let anzahlOffenerKonflikte = 0;

        // Iteriere durch jeden einzelnen Konflikt der Gruppe
        for (const konflikt of gruppe.konflikteInGruppe) {
            // Rufe die zentrale Service-Funktion auf
            //console.log(konflikt);
            const { anfragenToSave } = resolveEntgeltvergleichForSingleTopfConflict(konflikt, evuReihungen);

            // Füge modifizierte Anfragen zur Map hinzu
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));

            if (konflikt.status !== 'geloest') {
                anzahlOffenerKonflikte++;
            }
        
            const notizPrefix = `\nEntgeltvergleich Topf-Konflikt am ${new Date().toLocaleString()}: `;
            if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
            else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Kein eindeutiger Gewinner. Höchstpreisverfahren erforderlich.`;

            await konflikt.save();
        }

        // Aktualisiere den Gesamtstatus der Gruppe
        if (anzahlOffenerKonflikte > 0) {
            // Wenn mindestens ein Konflikt zum HP-Verfahren übergeht, ist die Gruppe auch in diesem Status
            const hatHPVerfahren = gruppe.konflikteInGruppe.some(k => k.status === 'in_bearbeitung_hoechstpreis');
            gruppe.status = hatHPVerfahren ? 'in_bearbeitung_hoechstpreis' : 'teilweise_geloest';
        } else {
            gruppe.status = 'vollstaendig_geloest';
        }
        
        // Notizen für die Gruppe
        if (notizen !== undefined) {
             const notizPrefix = `Gruppen-Notiz vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && gruppe.notizen) {
                gruppe.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                gruppe.notizen = notizPrefix + notizen;
            }
        }
        
        const aktualisierteGruppe = await gruppe.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of alleAnfragenZumSpeichern.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Entgeltvergleich für Topf-Konfliktgruppe ${gruppe._id} verarbeitet.`,
            data: {
                gruppe: aktualisierteGruppe,
                zusammenfassung: {
                    anzahlKonflikteInGruppe: gruppe.konflikteInGruppe.length,
                    davonGeloest: gruppe.konflikteInGruppe.length - anzahlOffenerKonflikte,
                    davonOffen: anzahlOffenerKonflikte
                }
            }
        });

    } catch (error) { 
        console.error(`Fehler bei PUT /api/konflikte/gruppen/${gruppenId}/entgeltvergleich:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung der Konfliktgruppe.' });
    }
};

// @desc    Führt den Entgeltvergleich für eine GANZE Slot-Konfliktgruppe durch
// @route   PUT /api/konflikte/slot-gruppen/:gruppenId/entgeltvergleich
exports.fuehreSlotGruppenEntgeltvergleichDurch = async (req, res) => {
    const { gruppenId } = req.params;
    const { notizen, notizenUpdateMode } = req.body || {};
    
    try {
        const gruppe = await KonfliktGruppe.findById(gruppenId)
    .populate({
        path: 'konflikteInGruppe',
        populate: [
            {
                path: 'ausloesenderSlot',
                select: '_id SlotID_Sprechend'
            },
            {
                path: 'beteiligteAnfragen',
                select: '_id Status Entgelt AnfrageID_Sprechend EVU ZugewieseneSlots',
                // NEUE, TIEFERE POPULATION
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf'
                }
            }
        ]
    });

        if (!gruppe) { return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' }); }
        
        let alleAnfragenZumSpeichern = new Map();
        let anzahlOffenerKonflikte = 0;

        for (const konflikt of gruppe.konflikteInGruppe) {
            if (konflikt.konfliktTyp !== 'SLOT' || !['in_bearbeitung_entgelt'].includes(konflikt.status)) continue;

            const { anfragenToSave } = resolveEntgeltvergleichForSingleSlotConflict(konflikt);
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));
            if (konflikt.status !== 'geloest') anzahlOffenerKonflikte++;
            const notizPrefix = `\nEntgeltvergleich Slot-Konflikt am ${new Date().toLocaleString()}: `;
            if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
            else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Kein eindeutiger Gewinner. Höchstpreisverfahren erforderlich.`;

            await konflikt.save();
        }

        // Aktualisiere den Gesamtstatus der Gruppe
        if (anzahlOffenerKonflikte > 0) {
            gruppe.status = 'in_bearbeitung_hoechstpreis'; // Wenn mind. einer zum HP geht
        } else {
            gruppe.status = 'vollstaendig_geloest';
        }

        // Notizen für die Gruppe
        if (notizen !== undefined) {
             const notizPrefix = `Gruppen-Notiz vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && gruppe.notizen) {
                gruppe.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                gruppe.notizen = notizPrefix + notizen;
            }
        }

        const aktualisierteGruppe = await gruppe.save();

        for (const anfrageDoc of alleAnfragenZumSpeichern.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Entgeltvergleich für Slot-Konfliktgruppe ${gruppe._id} verarbeitet.`,
            data: {
                gruppe: aktualisierteGruppe,
                zusammenfassung: {
                    anzahlKonflikteInGruppe: gruppe.konflikteInGruppe.length,
                    davonGeloest: gruppe.konflikteInGruppe.length - anzahlOffenerKonflikte,
                    davonOffen: anzahlOffenerKonflikte
                }
            }
        });

    } catch (error) { 
        console.error(`Fehler bei PUT /api/konflikte/slot-gruppen/${gruppenId}/entgeltvergleich:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung der Konfliktgruppe.' });
     }
};

// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens für eine GANZE Topf-Konfliktgruppe
// @route   PUT /api/konflikte/gruppen/:gruppenId/hoechstpreis-ergebnis
exports.verarbeiteGruppenHoechstpreisErgebnis = async (req, res) => {
    const { gruppenId } = req.params;
    const { ListeGeboteHoechstpreis, notizen, notizenUpdateMode } = req.body || {};
    //console.log(`Initiale Liste der Gebote: ${ListeGeboteHoechstpreis}`);
    
    // ... (Validierung und Laden der Gruppe wie in verarbeiteGruppenVerzichtVerschub) ...
    if (!mongoose.Types.ObjectId.isValid(gruppenId)) return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    
    // 1. Lade die Gruppe und alle zugehörigen Daten mit korrektem verschachteltem Populate
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'beteiligteAnfragen', // Optional, aber gut für direkten Zugriff auf die gemeinsamen Anfragen
                select: '_id Status Entgelt AnfrageID_Sprechend EVU Zugnummer'
            })
            .populate({
                path: 'konflikteInGruppe', // Population der Konfliktdokumente in der Gruppe
                populate: [ // NEU: Array, um mehrere Felder innerhalb der Konfliktdokumente zu populieren
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: 'maxKapazitaet TopfID _id ListeDerSlots'
                    },
                    {
                        path: 'beteiligteAnfragen', // JETZT wird auch dieses Feld in jedem Einzelkonflikt populiert
                        select: '_id Status Entgelt AnfrageID_Sprechend EVU Zugnummer ZugewieseneSlots',
                        populate: { // ...und innerhalb dieser Zuweisungen...
                            path: 'ZugewieseneSlots.slot',
                            model: 'Slot',
                            select: 'VerweisAufTopf' // ...den Verweis auf den Topf des Slots.
                        }
                    }
                ]
            });             

    if (!gruppe) return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
    if (gruppe.status !== 'in_bearbeitung_hoechstpreis') {
        return res.status(400).json({ message: `Konfliktgruppe hat Status '${gruppe.status}' und erwartet keine Höchstpreis-Ergebnisse.`});
    }

    try {
        let alleAnfragenZumSpeichern = new Map();
        let anzahlOffenerKonflikte = 0;

        // Iteriere durch jeden einzelnen Konflikt der Gruppe
        for (const konflikt of gruppe.konflikteInGruppe) {            
            if (!konflikt) {
                return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
            }
            if (konflikt.status !== 'in_bearbeitung_hoechstpreis') continue; // Überspringe ggf. schon gelöste Töpfe in der Gruppe

            if (!konflikt.ausloesenderKapazitaetstopf) {
                return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
            }
            
            const { anfragenToSave } = resolveHoechstpreisForSingleTopfConflict(
                konflikt,
                ListeGeboteHoechstpreis
            );

            // Füge modifizierte Anfragen zur Map hinzu
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));

            if (konflikt.status !== 'geloest') {
                anzahlOffenerKonflikte++;
            }

            const notizPrefix = `\nHöchstpreisrunde Topf-Konflikt am ${new Date().toLocaleString()}: `;
            if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
            else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Erneuter Gleichstand. Nächste Runde erforderlich.`;

            await konflikt.save();
        }

        // Aktualisiere den Gesamtstatus der Gruppe
        if (anzahlOffenerKonflikte > 0) {
            gruppe.status = 'in_bearbeitung_hoechstpreis'; // Wenn mind. ein Konflikt noch unentschieden ist
        } else {
            gruppe.status = 'vollstaendig_geloest';
        }
        
        // Notizen für die Gruppe
        if (notizen !== undefined) {
             const notizPrefix = `Gruppen-Notiz vom ${new Date().toLocaleString()}:\n`;
            if (notizenUpdateMode === 'append' && gruppe.notizen) {
                gruppe.notizen += "\n---\n" + notizPrefix + notizen;
            } else {
                gruppe.notizen = notizPrefix + notizen;
            }
        }
        
        const aktualisierteGruppe = await gruppe.save();

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of alleAnfragenZumSpeichern.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Höchstpreisverfahren für Konfliktgruppe ${gruppe._id} verarbeitet.`,
            data: {
                gruppe: aktualisierteGruppe,
                zusammenfassung: {
                    anzahlKonflikteInGruppe: gruppe.konflikteInGruppe.length,
                    davonGeloest: gruppe.konflikteInGruppe.length - anzahlOffenerKonflikte,
                    davonOffen: anzahlOffenerKonflikte
                }
            }
        });

    } catch (error) { 
        console.error(`Fehler bei PUT /api/konflikte/gruppen/${gruppenId}/hoechstpreis-ergebnis:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung der Konfliktgruppe.' });
     }
};

// --- Controller für eine GRUPPE von Slot-Konflikten (Höchstpreis) ---
// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens für eine ganze Slot-Konfliktgruppe
// @route   PUT /api/konflikte/slot-gruppen/:gruppenId/hoechstpreis-ergebnis
exports.verarbeiteSlotGruppenHoechstpreisErgebnis = async (req, res) => {
    const { gruppenId } = req.params;
    const { ListeGeboteHoechstpreis, notizen, notizenUpdateMode } = req.body || {};
    
    // ... (Validierung der gruppenId und Laden der Gruppe mit tiefer Population wie zuvor) ...
    if (!mongoose.Types.ObjectId.isValid(gruppenId)) return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    const gruppe = await KonfliktGruppe.findById(gruppenId)
    .populate({
        path: 'konflikteInGruppe',
        populate: [
            {
                path: 'ausloesenderSlot',
                select: '_id SlotID_Sprechend'
            },
            {
                path: 'beteiligteAnfragen',
                select: '_id Status Entgelt AnfrageID_Sprechend EVU ZugewieseneSlots',
                // NEUE, TIEFERE POPULATION
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf'
                }
            }
        ]
    });

    if (!gruppe) return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
    if (gruppe.status !== 'in_bearbeitung_hoechstpreis') return res.status(400).json({ message: `Konfliktgruppe hat Status '${gruppe.status}' und erwartet keine Höchstpreis-Ergebnisse.` });

    try {
        let alleAnfragenZumSpeichern = new Map();
        let anzahlOffenerKonflikte = 0;

        for (const konflikt of gruppe.konflikteInGruppe) {
            if (konflikt.konfliktTyp !== 'SLOT' || konflikt.status !== 'in_bearbeitung_hoechstpreis') continue;

            const { anfragenToSave } = resolveHoechstpreisForSingleSlotConflict(
                konflikt,
                ListeGeboteHoechstpreis // Übergebe die komplette Liste, die Service-Funktion filtert die relevanten Gebote
            );

            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));
            if (konflikt.status !== 'geloest') anzahlOffenerKonflikte++;

            const notizPrefix = `\nHöchstpreisrunde Slot-Konflikt am ${new Date().toLocaleString()}: `;
            if (konflikt.status === 'geloest') konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Konflikt gelöst.`;
            else konflikt.notizen = (konflikt.notizen || '') + `${notizPrefix}Erneuter Gleichstand. Nächste Runde erforderlich.`;

            await konflikt.save();
        }

        // Aktualisiere den Gesamtstatus der Gruppe
        if (anzahlOffenerKonflikte > 0) {
            gruppe.status = 'in_bearbeitung_hoechstpreis';
        } else {
            gruppe.status = 'vollstaendig_geloest';
        }
        if (notizen !== undefined) { /* ... Notizen für Gruppe ... */ }
        const aktualisierteGruppe = await gruppe.save();

        // Finalisiere die Anfrage-Updates
        for (const anfrageDoc of alleAnfragenZumSpeichern.values()) {
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Höchstpreisverfahren für Slot-Konfliktgruppe ${gruppe._id} verarbeitet.`,
            data: aktualisierteGruppe
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/slot-gruppen/${gruppenId}/hoechstpreis-ergebnis:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Verarbeitung der Slot-Konfliktgruppe.' });
    }
};

// @desc    Analysiert die Kapazität der Nachbartöpfe für eine Konfliktgruppe
// @route   GET /api/konflikte/gruppen/:gruppenId/verschiebe-analyse
exports.getVerschiebeAnalyseFuerGruppe = async (req, res) => {
    const { gruppenId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    }

    try {
        // 1. Lade die Gruppe und ihre Konflikte mit den zugehörigen Töpfen
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'konflikteInGruppe',
                populate: { path: 'ausloesenderKapazitaetstopf', select: 'TopfIDVorgänger TopfIDNachfolger TopfID' }
            })
            .populate('beteiligteAnfragen', 'AnfrageID_Sprechend EVU Zugnummer');

        if (!gruppe) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
        }

        // 2. Sammle die IDs aller einzigartigen Vorgänger- und Nachfolger-Töpfe
        const nachbarTopfIds = new Set();
        for (const konflikt of gruppe.konflikteInGruppe) {
            const topf = konflikt.ausloesenderKapazitaetstopf;
            if (topf) {
                if (topf.TopfIDVorgänger) nachbarTopfIds.add(topf.TopfIDVorgänger.toString());
                if (topf.TopfIDNachfolger) nachbarTopfIds.add(topf.TopfIDNachfolger.toString());
            }
        }

        // 3. Lade alle Nachbar-Töpfe mit allen für die Zählung benötigten, tief 
        // verschachtelten Daten in einer einzigen Abfrage
        const nachbarToepfeDetails = await Kapazitaetstopf.find({
            _id: { $in: Array.from(nachbarTopfIds) }
        }).select('maxKapazitaet ListeDerAnfragen TopfID')
          .populate({
                path: 'ListeDerAnfragen',
                select: 'ZugewieseneSlots',
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf'
                }
            });

        // Konvertiere die Ergebnisliste in eine Map für schnellen Zugriff
        const nachbarToepfeMap = new Map();
        nachbarToepfeDetails.forEach(t => nachbarToepfeMap.set(t._id.toString(), t));

        // 4. Erstelle die finale Antwortstruktur
        const analyseErgebnis = [];

        // Für jede beteiligte Anfrage...
        for (const anfrage of gruppe.beteiligteAnfragen) {
            const anfrageAnalyse = {
                anfrage: { // Infos zur Anfrage
                    _id: anfrage._id,
                    AnfrageID_Sprechend: anfrage.AnfrageID_Sprechend,
                    EVU: anfrage.EVU,
                    Zugnummer: anfrage.Zugnummer
                },
                topfAnalysen: [] // Hier kommen die Ergebnisse pro Topf rein
            };

            // ...prüfe jeden Konflikt-Topf in der Gruppe
            for (const konflikt of gruppe.konflikteInGruppe) {
                const topf = konflikt.ausloesenderKapazitaetstopf;
                if (!topf) continue;

                // --- NEUE STRUKTUR FÜR VORGÄNGER ---
                let vorgängerObjekt = null; // Standardwert ist null
                if (topf.TopfIDVorgänger) {
                    const vorgänger = nachbarToepfeMap.get(topf.TopfIDVorgänger.toString());
                    if (vorgänger) {
                        const aktiveAnzahl = getAktiveAnfragenAnzahlFuerTopf(vorgänger);
                        vorgängerObjekt = {
                            _id: vorgänger._id,
                            TopfID: vorgänger.TopfID, // Sprechende ID des Vorgängers
                            Status: aktiveAnzahl < vorgänger.maxKapazitaet ? 'frei' : 'belegt'
                        };
                    }
                }

                // --- NEUE STRUKTUR FÜR NACHFOLGER ---
                let nachfolgerObjekt = null; // Standardwert ist null
                if (topf.TopfIDNachfolger) {
                    const nachfolger = nachbarToepfeMap.get(topf.TopfIDNachfolger.toString());
                    if (nachfolger) {
                        const aktiveAnzahl = getAktiveAnfragenAnzahlFuerTopf(nachfolger);
                        nachfolgerObjekt = {
                            _id: nachfolger._id,
                            TopfID: nachfolger.TopfID, // Sprechende ID des Nachfolgers
                            Status: aktiveAnzahl < nachfolger.maxKapazitaet ? 'frei' : 'belegt'
                        };
                    }
                }
                
                anfrageAnalyse.topfAnalysen.push({
                    ausloesenderTopf: {
                        _id: topf._id,
                        TopfID: topf.TopfID
                    },
                    vorgänger: vorgängerObjekt,  // Objekt oder null
                    nachfolger: nachfolgerObjekt // Objekt oder null
                });
            }
            analyseErgebnis.push(anfrageAnalyse);
        }

        res.status(200).json({
            message: `Verschiebe-Analyse für Gruppe ${gruppe._id} erfolgreich.`,
            data: analyseErgebnis
        });

    } catch (error) {
        console.error(`Fehler bei der Verschiebe-Analyse für Gruppe ${gruppenId}:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Analyse.' });
    }
};

// @desc    Findet freie alternative Slots FÜR JEDE ANFRAGE in einer Konfliktgruppe
// @route   GET /api/konflikte/gruppen/:gruppenId/alternativen
exports.getAlternativSlotsFuerGruppe = async (req, res) => {
    const { gruppenId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    }

    try {
        // 1. Lade die Gruppe und alle relevanten, tief populierten Daten
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'konflikteInGruppe',
                populate: {
                    path: 'ausloesenderKapazitaetstopf',
                    select: 'Kalenderwoche Verkehrstag'
                }
            })
            .populate({
                path: 'beteiligteAnfragen',
                select: 'ListeGewuenschterSlotAbschnitte'
            });

        if (!gruppe || gruppe.beteiligteAnfragen.length === 0 || gruppe.konflikteInGruppe.length === 0) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden oder enthält keine relevanten Informationen.' });
        }

        // 2. Sammle die Kriterien für die Suche
        const uniqueDesiredSegments = new Map();
        const relevanteKonfliktKWs = new Set();
        const relevanteVerkehrstage = new Set(); // NEU: Sammle die Verkehrstage der Konflikttöpfe

        for (const konflikt of gruppe.konflikteInGruppe) {
            if (konflikt.ausloesenderKapazitaetstopf) {
                relevanteKonfliktKWs.add(konflikt.ausloesenderKapazitaetstopf.Kalenderwoche);
                relevanteVerkehrstage.add(konflikt.ausloesenderKapazitaetstopf.Verkehrstag);
            }
        }

        for (const anfrage of gruppe.beteiligteAnfragen) {
            for (const abschnitt of anfrage.ListeGewuenschterSlotAbschnitte) {
                const key = `${abschnitt.von}-${abschnitt.bis}`;
                if (!uniqueDesiredSegments.has(key)) {
                    uniqueDesiredSegments.set(key, { von: abschnitt.von, bis: abschnitt.bis });
                }
            }
        }
        
        if (relevanteKonfliktKWs.size === 0 || uniqueDesiredSegments.size === 0 || relevanteVerkehrstage.size === 0) {
            return res.status(200).json({ message: 'Keine relevanten Kriterien für die Analyse gefunden.', data: [] });
        }
        const desiredVonBisPairs = Array.from(uniqueDesiredSegments.values());

        // 3. Finde alle potenziell passenden alternativen Slots (in 2 Schritten)

        // Schritt 3a: Finde alle ELTERN-Slots, die zeitlich passen und komplett frei sind.
        const freieElternSlots = await Slot.find({
            slotStrukturTyp: 'ELTERN', // Nur Eltern
            zugewieseneAnfragen: { $size: 0 }, // Nur komplett freie Slot-Gruppen
            Kalenderwoche: { $in: Array.from(relevanteKonfliktKWs) },
            Verkehrstag: { $in: Array.from(relevanteVerkehrstage) }
        }).select('gabelAlternativen'); // Wir brauchen nur die Referenzen auf die Kinder

        // Sammle alle Kind-IDs aus den gefundenen freien Eltern-Slots
        const potentielleKindSlotIds = freieElternSlots.flatMap(e => e.gabelAlternativen);

        if (potentielleKindSlotIds.length === 0) {
            return res.status(200).json({ message: `Analyse für konfliktfreie Alternativen für Gruppe ${gruppenId} erfolgreich: Keine freien alternativen Slots gefunden.`, data: [] });
        }

        // Schritt 3b: Lade jetzt die KIND-Slots, die zu den freien Eltern gehören
        // UND den gewünschten Streckenabschnitten entsprechen.
        const potentialAlternativeSlots = await Slot.find({
            _id: { $in: potentielleKindSlotIds },
            slotStrukturTyp: 'KIND',
            $or: desiredVonBisPairs // Filtere nach den gewünschten von-bis Paaren
        })
        // Tieferes Populate, um Daten für die Zählung zu bekommen
        .populate({
            path: 'gabelElternSlot', // 1. Populiere den Eltern-Slot des Kindes
            select: 'VerweisAufTopf',   // Wir brauchen vom Eltern-Slot nur den Verweis auf den Topf
            populate: {             // 2. Populiere jetzt den Kapazitätstopf, der am Eltern-Slot hängt
                path: 'VerweisAufTopf',
                model: 'Kapazitaetstopf',
                // 3. Lade alle Daten, die wir für die intelligente Kapazitätsprüfung benötigen
                populate: {
                    path: 'ListeDerAnfragen',
                    select: 'ZugewieseneSlots',
                    populate: {
                        path: 'ZugewieseneSlots.slot',
                        model: 'Slot',
                        select: 'VerweisAufTopf'
                    }
                }
            }
        });

        // Filtere diese Slots weiter: Nur die, deren Kapazitätstopf ebenfalls frei ist
         const finalAlternativeSlots = potentialAlternativeSlots.filter(slot => {
            if (!slot.VerweisAufTopf) return false;
            
            // Rufe die zentrale Hilfsfunktion zum Zählen auf
            const aktiveAnzahlImTopf = getAktiveAnfragenAnzahlFuerTopf(slot.VerweisAufTopf);
            
            // Vergleiche die "aktive" Anzahl mit der maxKapazitaet
            return aktiveAnzahlImTopf < slot.VerweisAufTopf.maxKapazitaet;
        });

        // 4. Baue einen Cache auf für schnellen Zugriff: KW -> AbschnittKey -> [Slots]
        const alternativesCache = {};
        for (const slot of finalAlternativeSlots) {
            const kw = slot.Kalenderwoche;
            const abschnittKey = `${slot.von}-${slot.bis}`;
            if (!alternativesCache[kw]) alternativesCache[kw] = {};
            if (!alternativesCache[kw][abschnittKey]) alternativesCache[kw][abschnittKey] = [];
            alternativesCache[kw][abschnittKey].push(slot);
        }

        // 5. Erstelle die finale Antwortstruktur, indem durch jede Anfrage iteriert wird
        const analyseErgebnisProAnfrage = [];

        for (const anfrage of gruppe.beteiligteAnfragen) {
            const alternativenFuerDieseAnfrage = {}; // Temporäres Objekt für diese Anfrage zum Gruppieren

            // Iteriere durch die gewünschten Abschnitte DIESER Anfrage in ihrer korrekten Reihenfolge
            for (const gewuenschterAbschnitt of anfrage.ListeGewuenschterSlotAbschnitte) {
                const abschnittKey = `${gewuenschterAbschnitt.von}-${gewuenschterAbschnitt.bis}`;
                
                // Durchsuche die relevanten KWs
                for (const kw of relevanteKonfliktKWs) {
                    if (alternativesCache[kw] && alternativesCache[kw][abschnittKey]) {
                        // Es gibt Alternativen für diesen Abschnitt in dieser KW
                        const slotsFuerAbschnittInKw = alternativesCache[kw][abschnittKey];

                        // Gruppiere die gefundenen Slots nach ihrem Kapazitätstopf
                        for (const slot of slotsFuerAbschnittInKw) {
                            const topf = slot.VerweisAufTopf;
                            if (!alternativenFuerDieseAnfrage[kw]) alternativenFuerDieseAnfrage[kw] = {};
                            if (!alternativenFuerDieseAnfrage[kw][abschnittKey]) alternativenFuerDieseAnfrage[kw][abschnittKey] = {};
                            if (!alternativenFuerDieseAnfrage[kw][abschnittKey][topf.TopfID]) {
                                alternativenFuerDieseAnfrage[kw][abschnittKey][topf.TopfID] = {
                                    topfDetails: { _id: topf._id, TopfID: topf.TopfID, Zeitfenster: topf.Zeitfenster },
                                    freieSlots: []
                                };
                            }
                            alternativenFuerDieseAnfrage[kw][abschnittKey][topf.TopfID].freieSlots.push({
                                _id: slot._id, SlotID_Sprechend: slot.SlotID_Sprechend,
                                Abfahrt: slot.Abfahrt, Ankunft: slot.Ankunft
                            });
                        }
                    }
                }
            } // Ende Schleife über gewünschte Abschnitte

            // Konvertiere das gruppierte Objekt für diese Anfrage in die sortierte Array-Struktur
            const sortedAlternatives = Object.keys(alternativenFuerDieseAnfrage).sort((a,b) => parseInt(a) - parseInt(b)).map(kwKey => {
                const kw = parseInt(kwKey);
                const abschnitteData = alternativenFuerDieseAnfrage[kw];
                // Sortiere Abschnitte basierend auf der Reihenfolge in der Anfrage
                const chronologischSortierteAbschnitte = [];
                for (const gewuenschterAbschnitt of anfrage.ListeGewuenschterSlotAbschnitte) {
                    const abschnittKey = `${gewuenschterAbschnitt.von}-${gewuenschterAbschnitt.bis}`;
                    if(abschnitteData[abschnittKey]) {
                        chronologischSortierteAbschnitte.push({
                            abschnitt: abschnittKey,
                            kapazitaetstoepfe: Object.values(abschnitteData[abschnittKey]).sort((a, b) => 
                                ZEITFENSTER_SEQUENZ.indexOf(a.topfDetails.Zeitfenster) - ZEITFENSTER_SEQUENZ.indexOf(b.topfDetails.Zeitfenster)
                            )
                        });
                        // Sortiere die Slots im Topf nach Abfahrtszeit
                        chronologischSortierteAbschnitte[chronologischSortierteAbschnitte.length - 1].kapazitaetstoepfe.forEach(topfGruppe => {
                             topfGruppe.freieSlots.sort((a,b) => (a.Abfahrt.stunde*60+a.Abfahrt.minute) - (b.Abfahrt.stunde*60+b.Abfahrt.minute));
                        });
                    }
                }
                return { Kalenderwoche: kw, abschnitte: chronologischSortierteAbschnitte };
            });

            analyseErgebnisProAnfrage.push({
                anfrage: {
                    _id: anfrage._id,
                    AnfrageID_Sprechend: anfrage.AnfrageID_Sprechend,
                    EVU: anfrage.EVU,
                    Zugnummer: anfrage.Zugnummer
                },
                alternativen: sortedAlternatives
            });
        }

        res.status(200).json({
            message: `Analyse für konfliktfreie Alternativen für Gruppe ${gruppenId} erfolgreich.`,
            data: analyseErgebnisProAnfrage
        });

    } catch (error) {
        console.error(`Fehler bei der Alternativen-Analyse für Gruppe ${gruppenId}:`, error);
        res.status(500).json({ message: 'Serverfehler bei der Analyse.' });
    }
};

// @desc    Setzt eine komplette Konfliktgruppe zurück und aktualisiert den Status der Slots der Anfragen
// @route   POST /api/konflikte/gruppen/:gruppenId/reset
exports.resetKonfliktGruppe = async (req, res) => {
    const { gruppenId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    }

    try {
        // 1. Finde die Gruppe und ihre zugehörigen Dokumente
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'konflikteInGruppe',
                select: 'ausloesenderKapazitaetstopf konfliktTyp'
            });

        if (!gruppe) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
        }
        if (!gruppe.konflikteInGruppe || gruppe.konflikteInGruppe.length === 0 || gruppe.konflikteInGruppe[0].konfliktTyp !== 'KAPAZITAETSTOPF') {
            return res.status(400).json({ 
                message: `Reset nicht möglich. Diese Funktion ist nur für Topf-Konfliktgruppen.`
            });
        }

        const anfrageIdsToReset = gruppe.beteiligteAnfragen.map(id => id.toString());
        const konfliktDokuIdsToDelete = gruppe.konflikteInGruppe.map(k => k._id);
        const topfIdsInConflict = gruppe.konflikteInGruppe
            .map(k => k.ausloesenderKapazitaetstopf?._id.toString())
            .filter(id => id); // Filtere undefined/null heraus

        // 2. Setze den Status der betroffenen Slot-Zuweisungen in allen Anfragen der Gruppe zurück
        const anfragen = await Anfrage.find({ _id: { $in: anfrageIdsToReset } }).populate('ZugewieseneSlots.slot', 'VerweisAufTopf');

        for (const anfrage of anfragen) {
            let anfrageModifiziert = false;
            for (const zuweisung of anfrage.ZugewieseneSlots) {
                // Prüfe, ob der Slot zu einem der Konflikttöpfe dieser Gruppe gehört
                if (zuweisung.slot && zuweisung.slot.VerweisAufTopf && topfIdsInConflict.includes(zuweisung.slot.VerweisAufTopf.toString())) {
                    if (zuweisung.statusEinzelzuweisung !== 'initial_in_konfliktpruefung_topf') {
                        zuweisung.statusEinzelzuweisung = 'initial_in_konfliktpruefung_topf';                        
                    }
                    zuweisung.finalerTopfStatus = 'entscheidung_ausstehend';
                    // Entferne den Verweis auf das (bald gelöschte) Topf-Konfliktdokument
                    zuweisung.topfKonfliktDoku = null;
                    anfrageModifiziert = true;
                }
            }
            if (anfrageModifiziert) {
                anfrage.markModified('ZugewieseneSlots');
                await anfrage.updateGesamtStatus(); // Gesamtstatus neu berechnen
                await anfrage.save();
            }
        }
        console.log(`${anfragen.length} Anfragen wurden zurückgesetzt.`);

        // 3. Lösche alle zugehörigen Konfliktdokumentationen
        if (konfliktDokuIdsToDelete.length > 0) {
            const { deletedCount } = await KonfliktDokumentation.deleteMany({ _id: { $in: konfliktDokuIdsToDelete } });
            console.log(`${deletedCount} Konfliktdokumentationen wurden gelöscht.`);
        }

        // 4. Lösche die Konfliktgruppe selbst
        await KonfliktGruppe.findByIdAndDelete(gruppenId);
        console.log(`Konfliktgruppe ${gruppenId} wurde gelöscht.`);
        
        res.status(200).json({
            message: `Topf-Konfliktgruppe erfolgreich zurückgesetzt.`,
            summary: {
                anfragenZurueckgesetzt: anfragen.length,
                konfliktDokusGeloescht: konfliktDokuIdsToDelete.length,
                gruppeGeloeschtId: gruppenId
            }
        });

    } catch (error) {
        console.error(`Fehler beim Zurücksetzen der Topf-Konfliktgruppe ${gruppenId}:`, error);
        res.status(500).json({ message: 'Serverfehler beim Zurücksetzen der Gruppe.' });
    }
};

// @desc    Setzt eine komplette SLOT-Konfliktgruppe zurück und aktualisiert den Status der Slots der Anfragen
// @route   POST /api/konflikte/slot-gruppen/:gruppenId/reset
exports.resetSlotKonfliktGruppe = async (req, res) => {
    const { gruppenId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    }

    try {
        // 1a. Finde die Gruppe und lade den Typ ihrer Mitglieder via populate
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'konflikteInGruppe',
                select: 'konfliktTyp' // Lade nur das 'konfliktTyp'-Feld der Mitglieder
            });

        if (!gruppe) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
        }

        // 1b. Prüfe den Typ des ERSTEN Mitglieds der Gruppe. Annahme: Alle Mitglieder haben denselben Typ.
        if (!gruppe.konflikteInGruppe || gruppe.konflikteInGruppe.length === 0 || gruppe.konflikteInGruppe[0].konfliktTyp !== 'SLOT') {
            return res.status(400).json({ 
                message: `Reset nicht möglich. Diese Funktion ist nur für Slot-Konfliktgruppen.`
            });
        }

        const anfrageIdsToReset = gruppe.beteiligteAnfragen.map(id => id.toString());
        const konfliktDokuIdsToDelete = gruppe.konflikteInGruppe.map(k => k._id);

        // 2. Setze den Status der betroffenen Slot-Zuweisungen in den Anfragen zurück
        const anfragen = await Anfrage.find({ _id: { $in: anfrageIdsToReset } });

        for (const anfrage of anfragen) {
            let anfrageModifiziert = false;
            for (const zuweisung of anfrage.ZugewieseneSlots) {
                // Prüfe, ob diese Zuweisung von einem der zu löschenden Slot-Konfliktdokumente betroffen ist
                if (zuweisung.slotKonfliktDoku && konfliktDokuIdsToDelete.some(kId => kId.equals(zuweisung.slotKonfliktDoku))) {
                    
                    // --- HIER IST DIE NEUE KERNLOGIK ---
                    // Setze den Einzelstatus auf den gespeicherten finalen Topf-Status zurück
                    if (zuweisung.statusEinzelzuweisung !== zuweisung.finalerTopfStatus) {
                        zuweisung.statusEinzelzuweisung = zuweisung.finalerTopfStatus;                        
                    }
                    zuweisung.finalerSlotStatus = 'entscheidung_ausstehend';
                    // Entferne den Verweis auf das (bald gelöschte) Slot-Konfliktdokument
                    zuweisung.slotKonfliktDoku = null;
                    anfrageModifiziert = true;
                }
            }
            if (anfrageModifiziert) {
                anfrage.markModified('ZugewieseneSlots');
                await anfrage.updateGesamtStatus(); // Gesamtstatus neu berechnen
                await anfrage.save();
            }
        }
        console.log(`${anfragen.length} Anfragen wurden auf ihren finalen Topf-Status zurückgesetzt.`);

        // 3. Lösche alle zugehörigen Slot-Konfliktdokumentationen
        if (konfliktDokuIdsToDelete.length > 0) {
            const { deletedCount } = await KonfliktDokumentation.deleteMany({ _id: { $in: konfliktDokuIdsToDelete } });
            console.log(`${deletedCount} Slot-Konfliktdokumentationen wurden gelöscht.`);
        }

        // 4. Lösche die Slot-Konfliktgruppe selbst
        await KonfliktGruppe.findByIdAndDelete(gruppenId);
        console.log(`Slot-Konfliktgruppe ${gruppenId} wurde gelöscht.`);
        
        res.status(200).json({
            message: `Slot-Konfliktgruppe erfolgreich zurückgesetzt.`,
            summary: {
                anfragenZurueckgesetzt: anfragen.length,
                konfliktDokusGeloescht: konfliktDokuIdsToDelete.length,
                gruppeGeloeschtId: gruppenId
            }
        });

    } catch (error) {
        console.error(`Fehler beim Zurücksetzen der Slot-Konfliktgruppe ${gruppenId}:`, error);
        res.status(500).json({ message: 'Serverfehler beim Zurücksetzen der Gruppe.' });
    }
};

// @desc    Ruft eine einzelne, detaillierte Konfliktgruppe ab
// @route   GET /api/konflikte/gruppen/:gruppenId
exports.getKonfliktGruppeById = async (req, res) => {
    const { gruppenId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(gruppenId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    }
    try {
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            // Populate der Anfragen für die Gruppe
            .populate({
                path: 'beteiligteAnfragen',
                select: 'AnfrageID_Sprechend EVU Verkehrsart Entgelt Status Email ZugewieseneSlots', // Wichtig: 'ZugewieseneSlots' mitladen
                // NESTED POPULATE: Innerhalb der Anfragen die Slots laden
                populate: {
                    path: 'ZugewieseneSlots.slot',
                    model: 'Slot',
                    select: 'VerweisAufTopf' // Wichtig: Den Verweis zum Topf mitladen
                }
            })
            // Populate der Einzelkonflikte für die Gruppe  
            .populate({
                path: 'konflikteInGruppe',
                select: 'status konfliktTyp ausloesenderKapazitaetstopf ausloesenderSlot ReihungEntgelt',
                // HIER DIE ANPASSUNG: Wir populieren jetzt BEIDE möglichen Auslöser
                populate: [
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: '_id TopfID Abschnitt Kalenderwoche Verkehrstag Zeitfenster maxKapazitaet ListeDerSlots'
                    },
                    {
                        path: 'ausloesenderSlot',
                        select: '_id SlotID_Sprechend von bis Kalenderwoche Verkehrstag ListeDerSlots'
                    },
                    {
                        path: 'ReihungEntgelt.anfrage',
                        model: 'Anfrage',
                        select: 'AnfrageID_Sprechend EVU'
                    }
                ]
            });

        if (!gruppe) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
        }

        res.status(200).json({
            message: 'Konfliktgruppe erfolgreich abgerufen.',
            data: gruppe
        });
    } catch (error) {
        console.error(`Fehler beim Abrufen der Konfliktgruppe ${gruppenId}:`, error);
        res.status(500).json({ message: 'Serverfehler.' });
    }
};