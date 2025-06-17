// slot-buchungs-app/controllers/konfliktController.js
const mongoose = require('mongoose'); // Für ObjectId.isValid
const Kapazitaetstopf = require('../models/Kapazitaetstopf');
const KonfliktDokumentation = require('../models/KonfliktDokumentation');
const Anfrage = require('../models/Anfrage'); // für Populate
const Slot = require('../models/Slot'); // Benötigt, um Slot.VerweisAufTopf zu prüfen
const KonfliktGruppe = require('../models/KonfliktGruppe');
const konfliktService = require('../utils/konflikt.service');

// Wichtig: Die Zeitfenster-Sequenz für die Sortierung
const ZEITFENSTER_SEQUENZ = [
    '01-03', '03-05', '05-07', '07-09', '09-11', '11-13', 
    '13-15', '15-17', '17-19', '19-21', '21-23', '23-01'
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
 * @param {string|ObjectId} anfrageId - Die ID der zu aktualisierenden Anfrage.
 * @param {string} neuerEinzelStatus - Der neue Status für die relevanten Slot-Zuweisungen.
 * @param {ObjectId} ausloesenderTopfObjectId - Die ObjectId des Kapazitätstopfes, für den diese Entscheidung gilt.
 * @returns {Promise<Anfrage|null>} Das aktualisierte Anfrage-Objekt oder null bei Fehler.
 */
async function updateAnfrageSlotsStatusFuerTopf(anfrageId, neuerEinzelStatus, ausloesenderTopfObjectId) {
    const anfrageDoc = await Anfrage.findById(anfrageId).populate({
        path: 'ZugewieseneSlots.slot', // Populate das Slot-Objekt innerhalb des Arrays
        select: 'VerweisAufTopf SlotID_Sprechend' // Nur die benötigten Felder des Slots laden
    });

    if (!anfrageDoc) {
        console.warn(`Anfrage ${anfrageId} nicht gefunden beim Versuch, Einzelstatus zu aktualisieren.`);
        return null;
    }

    let anfrageModifiziert = false;
    if (anfrageDoc.ZugewieseneSlots && anfrageDoc.ZugewieseneSlots.length > 0) {
        for (const zuweisung of anfrageDoc.ZugewieseneSlots) {
            if (zuweisung.slot && zuweisung.slot.VerweisAufTopf && zuweisung.slot.VerweisAufTopf.equals(ausloesenderTopfObjectId)) {
                if (zuweisung.statusEinzelzuweisung !== neuerEinzelStatus) {
                    zuweisung.statusEinzelzuweisung = neuerEinzelStatus;
                    anfrageModifiziert = true;
                }
            }
        }
    }

    if (anfrageModifiziert) {
        anfrageDoc.markModified('ZugewieseneSlots');
        //console.log(`Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} vorher ${anfrageDoc.Status}`);
        await anfrageDoc.updateGesamtStatus(); // Methode aus Anfrage-Modell aufrufen
        await anfrageDoc.save();
        //console.log(`Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} nachher ${anfrageDoc.Status}`);
        console.log(`Einzelstatus und Gesamtstatus für Anfrage ${anfrageDoc.AnfrageID_Sprechend || anfrageDoc._id} auf ${anfrageDoc.Status} aktualisiert (neuer Einzelstatus für Topf ${ausloesenderTopfObjectId}: ${neuerEinzelStatus}).`);
    }
    return anfrageDoc;
};

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines Einzelkonflikts
 * in der Phase "Verzicht/Verschub". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt.
 * @param {Array} listeAnfragenMitVerzicht - Array von Anfrage-IDs.
 * @param {Array} listeAnfragenVerschubKoordination - Array von {anfrage, details} Objekten.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten, die gespeichert werden müssen.
 */
async function resolveVerzichtVerschubForSingleConflict(konflikt, listeAnfragenMitVerzicht = [], listeAnfragenVerschubKoordination = []) {
    const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;
    let anfragenToSave = new Map(); // Sammelt modifizierte Anfrage-Dokumente, um doppeltes Speichern zu vermeiden

    // Verzicht verarbeiten
    if (listeAnfragenMitVerzicht && Array.isArray(listeAnfragenMitVerzicht)) {
        konflikt.ListeAnfragenMitVerzicht = listeAnfragenMitVerzicht.map(item => 
            typeof item === 'string' ? item : item.anfrage || item._id || item
        );
        konflikt.markModified('ListeAnfragenMitVerzicht');
        for (const anfrageId of konflikt.ListeAnfragenMitVerzicht) {
            const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_verzichtet', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        }
    }

    // Verschub/Koordination verarbeiten
    if (listeAnfragenVerschubKoordination && Array.isArray(listeAnfragenVerschubKoordination)) {
        konflikt.ListeAnfragenVerschubKoordination = listeAnfragenVerschubKoordination; // Erwartet [{anfrage, details}]
        konflikt.markModified('ListeAnfragenVerschubKoordination');
        for (const item of konflikt.ListeAnfragenVerschubKoordination) {
            // Annahme: 'abgelehnt_topf_verschoben' für DIESEN Konfliktpunkt, da die Anfrage eine Alternative hat
            const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(item.anfrage, 'abgelehnt_topf_verschoben', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
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
            const updatedAnfrage =  await updateAnfrageSlotsStatusFuerTopf(anfrageDoc._id, 'bestaetigt_topf', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            anfrageDoc.markModified
        }
        console.log(`Konflikt ${konflikt._id} automatisch nach Verzicht/Verschub gelöst.`);
    } else {
        // Konflikt besteht weiterhin, bereit für Entgeltvergleich
        konflikt.status = 'in_bearbeitung_entgelt';
        konflikt.zugewieseneAnfragen = []; // Noch keine finale Zuweisung in diesem Schritt
        konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt am ${new Date().toLocaleString()} nach Verzicht/Verschub nicht gelöst. Nächster Schritt: Entgeltvergleich.`;
        console.log(`Konflikt ${konflikt._id} nach Verzicht/Verschub nicht gelöst, Status: ${konflikt.status}.`);
    }
    // Alte Resolution-Felder zurücksetzen, falls dies eine neue Lösung ist
    konflikt.abgelehnteAnfragenEntgeltvergleich = [];
    konflikt.abgelehnteAnfragenHoechstpreis = [];
    konflikt.ReihungEntgelt = [];
    konflikt.ListeGeboteHoechstpreis = [];

    return { anfragenToSave };
};

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines Einzelkonflikts
 * in der Phase "Entgeltvergleich". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
async function resolveEntgeltvergleichForSingleConflict(konflikt) {
        //console.log(konflikt);
        const ausloesenderTopfId = konflikt.ausloesenderKapazitaetstopf._id;
        const maxKap = konflikt.ausloesenderKapazitaetstopf.maxKapazitaet;
        let anfragenToSave = new Map();

        // Aktive Anfragen für diesen Konflikt ermitteln (die nicht verzichtet oder verschoben wurden)
        // Dies basiert auf den bereits im Konfliktdokument gespeicherten Listen
        const anfragenIdsMitVerzicht = new Set((konflikt.ListeAnfragenMitVerzicht || []).map(id => id.toString()));
        const anfragenIdsMitVerschub = new Set((konflikt.ListeAnfragenVerschubKoordination || []).map(item => item.anfrage.toString()));
        
        const aktiveAnfragenFuerEntgeltvergleich = konflikt.beteiligteAnfragen.filter(anfrageDoc => 
            !anfragenIdsMitVerzicht.has(anfrageDoc._id.toString()) && 
            !anfragenIdsMitVerschub.has(anfrageDoc._id.toString())
        );
        
        console.log(`Konflikt ${konflikt._id}: Entgeltvergleich wird durchgeführt für ${aktiveAnfragenFuerEntgeltvergleich.length} Anfragen.`);

        // ReihungEntgelt automatisch erstellen und sortieren
        konflikt.ReihungEntgelt = aktiveAnfragenFuerEntgeltvergleich
            .map(anfr => ({
                anfrage: anfr._id,
                entgelt: anfr.Entgelt || 0, // Nutze das in der Anfrage gespeicherte Entgelt
            }))
            .sort((a, b) => (b.entgelt || 0) - (a.entgelt || 0)); // Absteigend nach Entgelt

        konflikt.ReihungEntgelt.forEach((item, index) => item.rang = index + 1);
        konflikt.markModified('ReihungEntgelt');
        console.log(`Konflikt ${konflikt._id}: ReihungEntgelt automatisch erstellt mit ${konflikt.ReihungEntgelt.length} Einträgen.`);

        // Felder für Zuweisung/Ablehnung zurücksetzen, bevor sie neu befüllt werden
        konflikt.zugewieseneAnfragen = [];
        konflikt.abgelehnteAnfragenEntgeltvergleich = [];
        konflikt.abgelehnteAnfragenHoechstpreis = []; // Sicherstellen, dass dies auch leer ist für diese Phase
            
        let aktuelleKapazitaetBelegt = 0;
        let anfragenFuerHoechstpreis = []; // Sammelt Anfrage-IDs für den Fall eines Gleichstands
        let letztesAkzeptiertesEntgelt = null;
        let entgeltGleichstand = 0;

        for (const gereihteAnfrageItem of konflikt.ReihungEntgelt) {
            const anfrageId = gereihteAnfrageItem.anfrage; // Ist bereits ObjectId
            const anfrageEntgelt = gereihteAnfrageItem.entgelt;

            if (aktuelleKapazitaetBelegt < maxKap) {
                // Dieser Block prüft, ob die aktuelle Anfrage noch in die Kapazität passt.
                // Und ob es einen Gleichstand mit der nächsten gibt, falls dieser die Kapazität sprengen würde.
                let istGleichstandAnGrenze = false;
                const anzahlNochZuVergebenderPlaetze = maxKap - aktuelleKapazitaetBelegt;
                const anzahlKandidatenMitDiesemEntgelt = konflikt.ReihungEntgelt.filter(r => r.entgelt === anfrageEntgelt && !aktiveAnfragenFuerEntgeltvergleich.find(a => a._id.equals(r.anfrage) && (anfragenIdsMitVerzicht.has(a._id.toString()) || anfragenIdsMitVerschub.has(a._id.toString()))) ).length;


                if (anzahlKandidatenMitDiesemEntgelt > anzahlNochZuVergebenderPlaetze && anfrageEntgelt === gereihteAnfrageItem.entgelt) {
                     // Mehr Kandidaten mit diesem Entgelt als freie Plätze -> Alle mit diesem Entgelt gehen in Höchstpreis
                    istGleichstandAnGrenze = true;
                    entgeltGleichstand = anfrageEntgelt;
                }

                if (istGleichstandAnGrenze) {
                    konflikt.ReihungEntgelt.filter(r => r.entgelt === anfrageEntgelt).forEach(rAnfrage => {
                         if (!anfragenFuerHoechstpreis.some(id => id.equals(rAnfrage.anfrage))) {
                            anfragenFuerHoechstpreis.push(rAnfrage.anfrage);
                        }
                    });
                    // Da alle mit diesem Entgelt in HP gehen, werden hier keine weiteren Plätze belegt
                    // und wir können die Schleife für dieses Entgelt-Niveau beenden bzw. die nächsten nur noch ablehnen.
                    // Also: wir brechen hier nicht ab, sondern lassen die untere Logik die Ablehnung machen

                } else { //max Kapazität noch nicht erreicht
                    if(anfrageEntgelt >= entgeltGleichstand) { //freier Platz wird belegt
                        konflikt.zugewieseneAnfragen.push(anfrageId);
                        let updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'bestaetigt_topf_entgelt', ausloesenderTopfId);
                        if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                        aktuelleKapazitaetBelegt++;
                        letztesAkzeptiertesEntgelt = anfrageEntgelt; // Merke dir das Entgelt des letzten, der reingepasst hat
                    }else { // Sonderfall: letzte Plätze sind nur deswegen noch frei weil vorher Anfragen 
                            // ins Höchstpreisverfahren gegangen sind und um diese freien Plätze konkurrieren
                            // Die Anfragen mit geringerem Entgelt werden dann abgelehnt
                        konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageId);
                        let updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_entgelt', ausloesenderTopfId);
                        if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                    }
                    
                }
            } else { // Kapazität ist voll
                // Ist diese Anfrage Teil eines Gleichstands mit dem letzten akzeptierten?
                if (anfrageEntgelt === letztesAkzeptiertesEntgelt && !anfragenFuerHoechstpreis.some(id => id.equals(anfrageId))) {
                    // Ja, diese Anfrage gehört auch zu den Gleichstandskandidaten
                    anfragenFuerHoechstpreis.push(anfrageId);
                } else if (!anfragenFuerHoechstpreis.some(id => id.equals(anfrageId))) { 
                    // Nein, eindeutig zu niedriges Entgelt oder nicht Teil des Gleichstands -> Ablehnung
                    konflikt.abgelehnteAnfragenEntgeltvergleich.push(anfrageId);
                    let updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_entgelt', ausloesenderTopfId);
                    if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                }
            }
        } // Ende der Schleife durch ReihungEntgelt

        // Entferne die Höchstpreis-Kandidaten aus den regulär Zugewiesenen, falls sie dort gelandet sind
        if (anfragenFuerHoechstpreis.length > 0) {
            konflikt.zugewieseneAnfragen = konflikt.zugewieseneAnfragen.filter(
                zugewiesenId => !anfragenFuerHoechstpreis.some(hpId => hpId.equals(zugewiesenId))
            );
        }

        // Setze finalen Status für diesen Schritt
        if (anfragenFuerHoechstpreis.length > 0) {
            konflikt.status = 'in_bearbeitung_hoechstpreis';
            for (const anfrageId of anfragenFuerHoechstpreis) {
                let updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'wartet_hoechstpreis_topf', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            }
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Entgeltvergleich am ${new Date().toLocaleString()} führte zu Gleichstand. Höchstpreisverfahren für ${anfragenFuerHoechstpreis.length} Anfragen eingeleitet.`;
        } else { // Kein Gleichstand, Konflikt durch Entgelt gelöst
            konflikt.status = 'geloest';
            konflikt.abschlussdatum = new Date();
            konflikt.notizen = (konflikt.notizen ? konflikt.notizen + "\n---\n" : "") + `Konflikt durch Entgeltvergleich am ${new Date().toLocaleString()} gelöst.`;
        }
        
        konflikt.markModified('zugewieseneAnfragen');
        konflikt.markModified('abgelehnteAnfragenEntgeltvergleich');

    return { anfragenToSave };
};

/**
 * Service-Funktion: Enthält die Kernlogik zur Lösung eines Einzelkonflikts
 * in der Phase "Höchstpreisverfahren". Modifiziert Dokumente im Speicher.
 * @param {Document} konflikt - Das voll populierte KonfliktDokumentation-Objekt.
 * @param {Array} listeGeboteHoechstpreis - Array von {anfrage, gebot} Objekten aus dem Request.
 * @returns {Promise<{anfragenToSave: Map<string, Document>}>} Ein Objekt mit einer Map von modifizierten Anfrage-Dokumenten.
 */
async function resolveHoechstpreisForSingleConflict(konflikt, listeGeboteHoechstpreis = []) {
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
                valideGebote.push({ anfrage: anfrageKandidat._id, gebot: gebotEingang.gebot });
            } else {
                anfragenOhneValidesGebot.push(anfrageKandidat._id);
                const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageKandidat._id, 'abgelehnt_topf_hoechstpreis_ungueltig', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
            }
        } else {
            anfragenOhneValidesGebot.push(anfrageKandidat._id);
            const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageKandidat._id, 'abgelehnt_topf_hoechstpreis_kein_gebot', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
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
        const anfrageId = aktuellesGebot.anfrage;

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
                    if (!verbleibenImWartestatusHP.some(id => id.equals(gEqual.anfrage))) {
                        verbleibenImWartestatusHP.push(gEqual.anfrage);
                    }
                });
                verbleibendeKapFuerHP = 0; // Blockiert für diese Runde
                // Setze i, um die Schleife nach dieser Gleichstandsgruppe fortzusetzen (für Ablehnungen)
                const naechstesAnderesGebotIndex = valideGebote.findIndex(g => g.gebot < aktuellesGebot.gebot);
                i = (naechstesAnderesGebotIndex === -1) ? valideGebote.length -1 : naechstesAnderesGebotIndex -1;
            } else { // Eindeutig gewonnen oder Gleichstand, der noch reinpasst
                neuZugewiesenInHP.push(anfrageId);
                const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'bestaetigt_topf_hoechstpreis', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
                verbleibendeKapFuerHP--;
            }
        } else { // Keine Kapazität mehr
            if (!verbleibenImWartestatusHP.some(idW => idW.equals(anfrageId))) {
                neuAbgelehntInHPWegenKap.push(anfrageId);
                const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'abgelehnt_topf_hoechstpreis', ausloesenderTopfId);
                if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
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
        for (const anfrageId of verbleibenImWartestatusHP) { // Status der Wartenden explizit setzen/bestätigen
            const updatedAnfrage = await updateAnfrageSlotsStatusFuerTopf(anfrageId, 'wartet_hoechstpreis_topf', ausloesenderTopfId);
            if(updatedAnfrage) anfragenToSave.set(updatedAnfrage._id.toString(), updatedAnfrage);
        }
    } else {
        konflikt.status = 'geloest';
        konflikt.abschlussdatum = new Date();
        konflikt.notizen = `${konflikt.notizen || ''}\nKonflikt durch Höchstpreisverfahren am ${new Date().toLocaleString()} gelöst. Zugewiesen: ${neuZugewiesenInHP.length}, Abgelehnt wg. Kap: ${neuAbgelehntInHPWegenKap.length}, Ungült./Kein Gebot: ${anfragenOhneValidesGebot.length}.`;
    }

    return {anfragenToSave};
}

// @desc    Synchronisiert Konfliktstatus: Identifiziert Überbuchungen in Töpfen,
//          erstellt/aktualisiert Konfliktdokumente UND aktualisiert den Status
//          der betroffenen Slot-Zuweisungen in den Anfragen.
// @route   POST /api/konflikte/identifiziere-topf-konflikte
exports.identifiziereTopfKonflikte = async (req, res) => {
    try {
        const alleToepfe = await Kapazitaetstopf.find({})
            .populate('ListeDerAnfragen', '_id AnfrageID_Sprechend Status Entgelt') // Entgelt für spätere Reihung
            .populate('ListeDerSlots', '_id SlotID_Sprechend');

        let neuErstellteKonfliktDokus = [];
        let aktualisierteUndGeoeffneteKonflikte = [];
        let unveraenderteBestehendeKonflikte = [];
        let autoGeloesteKonflikte = []; // Um aufzulisten, welche Konflikte sich von selbst gelöst haben
        let toepfeOhneKonflikt = [];

        for (const topf of alleToepfe) {
            const istUeberbucht = topf.ListeDerAnfragen.length > topf.maxKapazitaet;

            if (istUeberbucht) {
                console.log(`Konflikt in Topf ${topf.TopfID || topf._id}: ${topf.ListeDerAnfragen.length} Anfragen > maxKap ${topf.maxKapazitaet}`);

                // 1. Konfliktdokument erstellen oder aktualisieren
                let konfliktDoku = await KonfliktDokumentation.findOne({
                    ausloesenderKapazitaetstopf: topf._id
                }).sort({ updatedAt: -1 });

                const aktuelleAnfragenAmTopfIds = topf.ListeDerAnfragen.map(a => a._id);

                if (konfliktDoku) {
                    const gespeicherteAnfragenImKonfliktIds = konfliktDoku.beteiligteAnfragen;
                    if (!sindObjectIdArraysGleich(aktuelleAnfragenAmTopfIds, gespeicherteAnfragenImKonfliktIds)) {
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
                    } else {
                        console.log(`Konfliktdokument ${konfliktDoku._id} für Topf ${topf.TopfID}: Beteiligte Anfragen sind identisch. Status (${konfliktDoku.status}) bleibt erhalten.`);
                        unveraenderteBestehendeKonflikte.push(konfliktDoku);
                    }
                } else {
                    const neuesKonfliktDoku = new KonfliktDokumentation({
                        beteiligteAnfragen: aktuelleAnfragenAmTopfIds,
                        ausloesenderKapazitaetstopf: topf._id,
                        konfliktTyp: 'KAPAZITAETSTOPF',
                        status: 'offen',
                        notizen: `Automatisch erstellter Konflikt für Kapazitätstopf ${topf.TopfID || topf._id} am ${new Date().toISOString()}. ${topf.ListeDerAnfragen.length} Anfragen bei max. Kapazität von ${topf.maxKapazitaet}.`
                    });
                    await neuesKonfliktDoku.save();
                    neuErstellteKonfliktDokus.push(neuesKonfliktDoku);
                    console.log(`Neues Konfliktdokument ${neuesKonfliktDoku._id} für Topf ${topf.TopfID} erstellt.`);
                }

                // 2. Status der Anfragen aktualisieren
                // Alle Anfragen in diesem überbuchten Topf erhalten für die relevanten Slots den Status 'wartet_konflikt_topf'
                for (const anfrage of topf.ListeDerAnfragen) {
                    await updateAnfrageSlotsStatusFuerTopf(anfrage._id, 'wartet_konflikt_topf', topf._id);
                }

            } else {
                toepfeOhneKonflikt.push(topf.TopfID || topf._id);

                // 1. Status der Anfragen aktualisieren
                // Alle Anfragen in diesem Topf sind für die Slots dieses Topfes "bestätigt" (auf Topf-Ebene)
                for (const anfrage of topf.ListeDerAnfragen) {
                    await updateAnfrageSlotsStatusFuerTopf(anfrage._id, 'bestaetigt_topf', topf._id);
                }

                // 2. Prüfen, ob für diesen Topf ein alter, offener Konflikt existiert und ihn automatisch lösen
                const offenerKonflikt = await KonfliktDokumentation.findOne({
                    ausloesenderKapazitaetstopf: topf._id,
                    status: { $ne: 'geloest' } // Finde einen, der noch nicht als gelöst markiert ist
                });

                if (offenerKonflikt) {
                    console.log(`Konflikt ${offenerKonflikt._id} für Topf ${topf.TopfID} wird automatisch gelöst, da keine Überbuchung mehr besteht.`);
                    offenerKonflikt.status = 'geloest';
                    offenerKonflikt.abschlussdatum = new Date();
                    offenerKonflikt.notizen = `${offenerKonflikt.notizen || ''}\nKonflikt am ${new Date().toISOString()} automatisch gelöst, da Kapazität nicht mehr überschritten.`;
                    // Die Anfragen, die noch im Topf sind, sind die "Gewinner"
                    offenerKonflikt.zugewieseneAnfragen = topf.ListeDerAnfragen.map(a => a._id);
                    await offenerKonflikt.save();
                    autoGeloesteKonflikte.push(offenerKonflikt);
                }
            }
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
            .populate('ausloesenderKapazitaetstopf', 'TopfID Verkehrsart maxKapazitaet')
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
            // Stufe 1: Populiere den auslösenden Kapazitätstopf
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
            .populate([
                { path: 'beteiligteAnfragen', select: 'AnfrageID_Sprechend EVU Zugnummer Status Verkehrsart Entgelt' },
                { path: 'zugewieseneAnfragen', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'abgelehnteAnfragenEntgeltvergleich', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'abgelehnteAnfragenHoechstpreis', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'ListeAnfragenMitVerzicht', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' },
                { path: 'ListeAnfragenVerschubKoordination.anfrage', select: 'AnfrageID_Sprechend EVU Zugnummer Verkehrsart' }
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
// @desc    Verarbeitet Verzichte/Verschiebungen und löst Konflikt ggf. automatisch
// @route   PUT /api/konflikte/:konfliktId/verzicht-verschub
exports.verarbeiteVerzichtVerschub = async (req, res) => {
    const { konfliktId } = req.params;
    const { ListeAnfragenMitVerzicht, ListeAnfragenVerschubKoordination, notizen, notizenUpdateMode } = req.body;

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('beteiligteAnfragen', '_id Status Entgelt') // Lade _id und Status für Filterung und Entgelt für Info
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet TopfID _id');

        if (!konflikt) {
            return res.status(404).json({ message: 'Konfliktdokumentation nicht gefunden.' });
        }
        if (!konflikt.ausloesenderKapazitaetstopf) {
            return res.status(500).json({ message: 'Konfliktdokumentation hat keinen verknüpften Kapazitätstopf.' });
        }
        // Erlaube Bearbeitung nur, wenn Status z.B. 'offen' oder 'in_bearbeitung' (oder spezifischer vorheriger Schritt)
        if (!['offen', 'in_bearbeitung'].includes(konflikt.status)) {
            return res.status(400).json({ message: `Konflikt ist im Status '${konflikt.status}' und kann nicht über diesen Endpunkt bearbeitet werden.` });
        }

        // Rufe die zentrale Service-Funktion auf        
        const { anfragenToSave } = await resolveVerzichtVerschubForSingleConflict(
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

        const aktualisierterKonflikt = await konflikt.save(); // Speichere das Konfliktdokument

        

        // Rufe für alle geänderten Anfragen den Gesamtstatus-Update auf
        for (const anfrageDoc of anfragenToSave.values()) {
            //console.log(`anfragenToSave ${anfragenToSave}, anfrageDoc ${anfrageDoc}`);
            await anfrageDoc.updateGesamtStatus();
            await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Verzicht/Verschub für Konflikt ${konflikt.TopfID || konflikt._id} verarbeitet. Neuer Status: ${aktualisierterKonflikt.status}`,
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

// Phase 2 Controller-Funktion
// @desc    Führt den Entgeltvergleich für einen Konflikt durch
// @route   PUT /api/konflikte/:konfliktId/entgeltvergleich
exports.fuehreEntgeltvergleichDurch = async (req, res) => {    
    const { konfliktId } = req.params;
    const { notizen, notizenUpdateMode } = req.body || {}; // Nur Notizen werden optional erwartet

    if (!mongoose.Types.ObjectId.isValid(konfliktId)) {
        return res.status(400).json({ message: 'Ungültiges Format für Konflikt-ID.' });
    }

    try {
        const konflikt = await KonfliktDokumentation.findById(konfliktId)
            .populate('beteiligteAnfragen', '_id Status Entgelt AnfrageID_Sprechend EVU')
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet TopfID _id');

        if (!konflikt) {
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
        const { anfragenToSave } = await resolveEntgeltvergleichForSingleConflict(konflikt);
       

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

        const aktualisierterKonflikt = await konflikt.save();

        res.status(200).json({
            message: `Entgeltvergleich für Konflikt ${konflikt.TopfID || konflikt._id} durchgeführt. Neuer Status: ${aktualisierterKonflikt.status}`,
            data: aktualisierterKonflikt
        });

    } catch (error) {
        console.error(`Fehler bei PUT /api/konflikte/${konfliktId}/entgeltvergleich:`, error);
        // ... (Standardfehlerbehandlung)
        res.status(500).json({ message: 'Serverfehler beim Durchführen des Entgeltvergleichs.' });
    }
};

// Phase 3 Controller-Funktion
// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens
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
            .populate('beteiligteAnfragen', '_id Status Entgelt AnfrageID_Sprechend ZugewieseneSlots') // Entgelt für Gebotsvalidierung
            .populate('ausloesenderKapazitaetstopf', 'maxKapazitaet TopfID _id');

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
        const { anfragenToSave } = await resolveHoechstpreisForSingleConflict(konflikt, ListeGeboteHoechstpreis);


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

// @desc    Ruft alle persistierten Konfliktgruppen ab
// @route   GET /api/konflikte/gruppen
exports.identifiziereKonfliktGruppen = async (req, res) => {
    try {        
        // Filtere optional nach Status der Gruppe, z.B. alle, die nicht gelöst sind
        const filter = { status: { $ne: 'vollstaendig_geloest' } };

        const gruppen = await KonfliktGruppe.find(filter)
            .populate('beteiligteAnfragen', 'AnfrageID_Sprechend EVU Entgelt Verkehrsart')
            .populate({
                path: 'konflikteInGruppe',
                select: 'status ausloesenderKapazitaetstopf',
                populate: {
                    path: 'ausloesenderKapazitaetstopf',
                    select: 'TopfID maxKapazitaet'
                }
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

// @desc    Verarbeitet Verzichte/Verschiebungen für eine ganze Konfliktgruppe
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
                path: 'beteiligteAnfragen',
                select: '_id Status Entgelt' // Felder, die wir von den Anfragen brauchen
            })
            .populate({
                path: 'konflikteInGruppe', // Lade die einzelnen Konfliktdokumente
                populate: {
                    path: 'ausloesenderKapazitaetstopf', // Lade zu jedem Konfliktdokument den Topf
                    select: 'maxKapazitaet TopfID _id'
                }
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
            // Rufe die zentrale Service-Funktion auf
            const { anfragenToSave } = await resolveVerzichtVerschubForSingleConflict(
                konflikt,
                ListeAnfragenMitVerzicht,
                ListeAnfragenVerschubKoordination
            );

            // Füge modifizierte Anfragen zur Map hinzu (Duplikate werden durch Map-Struktur vermieden)
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));

            if (konflikt.status !== 'geloest') {
                anzahlOffenerKonflikte++;
            }
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
            console.log(`anfrageDoc vor Statusupdate ${anfrageDoc}`);
             await anfrageDoc.updateGesamtStatus();
             console.log(`anfrageDoc nach Statusupdate ${anfrageDoc}`);
             await anfrageDoc.save();
        }

        res.status(200).json({
            message: `Verzicht/Verschub für Konfliktgruppe ${gruppe._id} verarbeitet.`,
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

// @desc    Führt den Entgeltvergleich für eine GANZE Konfliktgruppe durch
// @route   PUT /api/konflikte/gruppen/:gruppenId/entgeltvergleich
exports.fuehreGruppenEntgeltvergleichDurch = async (req, res) => {
    const { gruppenId } = req.params;
    const { notizen, notizenUpdateMode } = req.body || {};
    
    // ... (Validierung und Laden der Gruppe wie in verarbeiteGruppenVerzichtVerschub) ...
    if (!mongoose.Types.ObjectId.isValid(gruppenId)) return res.status(400).json({ message: 'Ungültiges Format für Gruppen-ID.' });
    
    // 1. Lade die Gruppe und alle zugehörigen Daten mit korrektem verschachteltem Populate
        const gruppe = await KonfliktGruppe.findById(gruppenId)
            .populate({
                path: 'beteiligteAnfragen', // Optional, aber gut für direkten Zugriff auf die gemeinsamen Anfragen
                select: '_id Status Entgelt AnfrageID_Sprechend EVU'
            })
            .populate({
                path: 'konflikteInGruppe', // Population der Konfliktdokumente in der Gruppe
                populate: [ // NEU: Array, um mehrere Felder innerhalb der Konfliktdokumente zu populieren
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: 'maxKapazitaet TopfID _id'
                    },
                    {
                        path: 'beteiligteAnfragen', // JETZT wird auch dieses Feld in jedem Einzelkonflikt populiert
                        select: '_id Status Entgelt AnfrageID_Sprechend EVU'
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
            const { anfragenToSave } = await resolveEntgeltvergleichForSingleConflict(konflikt);

            // Füge modifizierte Anfragen zur Map hinzu
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));

            if (konflikt.status !== 'geloest') {
                anzahlOffenerKonflikte++;
            }
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
            message: `Entgeltvergleich für Konfliktgruppe ${gruppe._id} verarbeitet.`,
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

// @desc    Verarbeitet das Ergebnis des Höchstpreisverfahrens für eine GANZE Konfliktgruppe
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
                select: '_id Status Entgelt AnfrageID_Sprechend EVU'
            })
            .populate({
                path: 'konflikteInGruppe', // Population der Konfliktdokumente in der Gruppe
                populate: [ // NEU: Array, um mehrere Felder innerhalb der Konfliktdokumente zu populieren
                    {
                        path: 'ausloesenderKapazitaetstopf',
                        select: 'maxKapazitaet TopfID _id'
                    },
                    {
                        path: 'beteiligteAnfragen', // JETZT wird auch dieses Feld in jedem Einzelkonflikt populiert
                        select: '_id Status Entgelt AnfrageID_Sprechend EVU ZugewieseneSlots'
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
            
            const { anfragenToSave } = await resolveHoechstpreisForSingleConflict(
                konflikt,
                ListeGeboteHoechstpreis
            );

            // Füge modifizierte Anfragen zur Map hinzu
            anfragenToSave.forEach((doc, id) => alleAnfragenZumSpeichern.set(id, doc));

            if (konflikt.status !== 'geloest') {
                anzahlOffenerKonflikte++;
            }
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
                populate: {
                    path: 'ausloesenderKapazitaetstopf',
                    select: 'TopfIDVorgänger TopfIDNachfolger TopfID' // Lade Links und ID des auslösenden Topfes
                }
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

        // 3. Lade alle Nachbar-Töpfe und ihre Kapazitätsdaten in einer einzigen Abfrage
        const nachbarToepfeDetails = await Kapazitaetstopf.find({
            _id: { $in: Array.from(nachbarTopfIds) }
        }).select('maxKapazitaet ListeDerAnfragen TopfID'); // WICHTIG: TopfID mitladen

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
                        vorgängerObjekt = {
                            _id: vorgänger._id,
                            TopfID: vorgänger.TopfID, // Sprechende ID des Vorgängers
                            Status: vorgänger.ListeDerAnfragen.length < vorgänger.maxKapazitaet ? 'frei' : 'belegt'
                        };
                    }
                }

                // --- NEUE STRUKTUR FÜR NACHFOLGER ---
                let nachfolgerObjekt = null; // Standardwert ist null
                if (topf.TopfIDNachfolger) {
                    const nachfolger = nachbarToepfeMap.get(topf.TopfIDNachfolger.toString());
                    if (nachfolger) {
                        nachfolgerObjekt = {
                            _id: nachfolger._id,
                            TopfID: nachfolger.TopfID, // Sprechende ID des Nachfolgers
                            Status: nachfolger.ListeDerAnfragen.length < nachfolger.maxKapazitaet ? 'frei' : 'belegt'
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

        // 3. Finde alle potenziell passenden alternativen Slots mit verfeinertem Filter
        const potentialAlternativeSlots = await Slot.find({
            zugewieseneAnfragen: { $size: 0 },
            Kalenderwoche: { $in: Array.from(relevanteKonfliktKWs) },
            Verkehrstag: { $in: Array.from(relevanteVerkehrstage) }, // NEUER, EFFIZIENTER FILTER
            $or: desiredVonBisPairs
        }).populate({
            path: 'VerweisAufTopf',
            select: 'maxKapazitaet ListeDerAnfragen TopfID Zeitfenster'
        });

        // Filtere diese Slots weiter: Nur die, deren Kapazitätstopf ebenfalls frei ist
        const finalAlternativeSlots = potentialAlternativeSlots.filter(slot => 
            slot.VerweisAufTopf && slot.VerweisAufTopf.ListeDerAnfragen.length < slot.VerweisAufTopf.maxKapazitaet
        );

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
                select: 'ausloesenderKapazitaetstopf'
            });

        if (!gruppe) {
            return res.status(404).json({ message: 'Konfliktgruppe nicht gefunden.' });
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
                        anfrageModifiziert = true;
                    }
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
            message: `Konfliktgruppe erfolgreich zurückgesetzt.`,
            summary: {
                anfragenZurueckgesetzt: anfragen.length,
                konfliktDokusGeloescht: konfliktDokuIdsToDelete.length,
                gruppeGeloeschtId: gruppenId
            }
        });

    } catch (error) {
        console.error(`Fehler beim Zurücksetzen der Konfliktgruppe ${gruppenId}:`, error);
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
            .populate('beteiligteAnfragen', 'AnfrageID_Sprechend EVU Verkehrsart Status Entgelt Email')
            .populate({
                path: 'konflikteInGruppe',
                select: 'ausloesenderKapazitaetstopf',
                populate: {
                    path: 'ausloesenderKapazitaetstopf',
                    select: 'Abschnitt Kalenderwoche Verkehrstag Zeitfenster'
                }
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