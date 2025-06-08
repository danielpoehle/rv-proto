const mongoose = require('mongoose');
const Kapazitaetstopf = require('../models/Kapazitaetstopf');

const ZEITFENSTER_SEQUENZ = [
    '01-03', '03-05', '05-07', '07-09', '09-11', '11-13', 
    '13-15', '15-17', '17-19', '19-21', '21-23', '23-01'
];

function getVorgängerZeitfenster(aktuellesZeitfenster) {
    const index = ZEITFENSTER_SEQUENZ.indexOf(aktuellesZeitfenster);
    return (index > 0) ? ZEITFENSTER_SEQUENZ[index - 1] : null;
};

function getNachfolgerZeitfenster(aktuellesZeitfenster) {
    const index = ZEITFENSTER_SEQUENZ.indexOf(aktuellesZeitfenster);
    return (index > -1 && index < ZEITFENSTER_SEQUENZ.length - 1) ? ZEITFENSTER_SEQUENZ[index + 1] : null;
};

async function findAndLinkLogic(neuerTopf){
    console.log(`Suche Vorgänger und Nachfolger für Topf ${neuerTopf._id}`);
    let vorgänger = null;
    let nachfolger = null;

    // --- Suche nach Vorgänger ---
    const vorgaengerZeitfenster = getVorgängerZeitfenster(neuerTopf.Zeitfenster);
    if (vorgaengerZeitfenster) {
        vorgänger = await Kapazitaetstopf.findOne({
            Abschnitt: neuerTopf.Abschnitt,
            Kalenderwoche: neuerTopf.Kalenderwoche,
            Verkehrstag: neuerTopf.Verkehrstag,
            Verkehrsart: neuerTopf.Verkehrsart,
            Zeitfenster: vorgaengerZeitfenster
        });
    } else { // Sonderfall: Erstes Zeitfenster des Tages ('01-03' -> '23-01')
             // Dein Beispiel: Vorgänger von KW3 / 01-03 ist KW2 / 23-01
             // Dies erfordert eine klare Regel, welches das "erste" Zeitfenster des Tages ist.
             // Annahme nach deiner Sequenz: Das erste ist '01-03'.
        if (neuerTopf.Zeitfenster === ZEITFENSTER_SEQUENZ[0]) { // Wenn es das erste Fenster der Sequenz ist
            vorgänger = await Kapazitaetstopf.findOne({
                Abschnitt: neuerTopf.Abschnitt,
                Kalenderwoche: neuerTopf.Kalenderwoche - 1, // Vorherige Kalenderwoche
                Verkehrstag: neuerTopf.Verkehrstag,
                Verkehrsart: neuerTopf.Verkehrsart,
                Zeitfenster: ZEITFENSTER_SEQUENZ[ZEITFENSTER_SEQUENZ.length - 1] // Das letzte Fenster der Sequenz
            });
        }
    }
        
    // --- Suche nach Nachfolger ---
    const nachfolgerZeitfenster = getNachfolgerZeitfenster(neuerTopf.Zeitfenster);
    if (nachfolgerZeitfenster) {
        nachfolger = await Kapazitaetstopf.findOne({
            Abschnitt: neuerTopf.Abschnitt,
            Kalenderwoche: neuerTopf.Kalenderwoche,
            Verkehrstag: neuerTopf.Verkehrstag,
            Verkehrsart: neuerTopf.Verkehrsart,
            Zeitfenster: nachfolgerZeitfenster
        });
    } else { // Sonderfall: Letztes Zeitfenster des Tages ('23-01' -> '01-03')
             // Dein Beispiel: Nachfolger von KW3 / 23-01 ist KW4 / 01-03
             // Dies erfordert eine klare Regel, welches das "erste" Zeitfenster des Tages ist.
             // Annahme nach deiner Sequenz: Das erste ist '01-03'.
        if (neuerTopf.Zeitfenster === ZEITFENSTER_SEQUENZ[ZEITFENSTER_SEQUENZ.length - 1]) { // Wenn es das letzte Fenster der Sequenz ist
            nachfolger = await Kapazitaetstopf.findOne({
                Abschnitt: neuerTopf.Abschnitt,
                Kalenderwoche: neuerTopf.Kalenderwoche + 1, // Nächste Kalenderwoche
                Verkehrstag: neuerTopf.Verkehrstag,
                Verkehrsart: neuerTopf.Verkehrsart,
                Zeitfenster: ZEITFENSTER_SEQUENZ[0] // Das erste Fenster der Sequenz
            });
        }
    }

    // --- Verknüpfungen setzen und speichern ---
    let mussNeuerTopfErneutGespeichertWerden = false;
    if (vorgänger) {
        console.log(`Vorgänger-Topf gefunden für Topf ${neuerTopf._id}: Topf ${vorgänger._id}`);
        // Setze Verknüpfungen
        neuerTopf.TopfIDVorgänger = vorgänger._id;
        vorgänger.TopfIDNachfolger = neuerTopf._id;
        
        await vorgänger.save(); // Speichere den aktualisierten Vorgänger
        mussNeuerTopfErneutGespeichertWerden = true;
    } else{
        console.log(`Kein Vorgänger-Topf gefunden für Topf ${neuerTopf._id}`);
    }

    if (nachfolger) {
        console.log(`Nachfolger-Topf gefunden für Topf ${neuerTopf._id}: Topf ${nachfolger._id}`);
        // Setze Verknüpfungen
        neuerTopf.TopfIDNachfolger = nachfolger._id;
        nachfolger.TopfIDVorgänger = neuerTopf._id;

        await nachfolger.save(); // Speichere den aktualisierten Nachfolger
        mussNeuerTopfErneutGespeichertWerden = true;
    } else{
        console.log(`Kein Nachfolger-Topf gefunden für Topf ${neuerTopf._id}`);
    }
        
    let finalerTopf = neuerTopf;
    if (mussNeuerTopfErneutGespeichertWerden) {
        finalerTopf = await neuerTopf.save(); // Speichere den neuen Topf erneut mit den Verknüpfungen
    }

    return finalerTopf;
};

/**
 * ZENTRALE SERVICE-FUNKTION: Erstellt einen neuen Kapazitätstopf UND verknüpft ihn mit seinen Nachbarn.
 * @param {object} topfData - Die Daten für den neuen Topf (Abschnitt, KW, VT, VA, Zeitfenster).
 * @returns {Promise<Document>} Das final gespeicherte und verknüpfte Kapazitätstopf-Dokument.
 */
async function createAndLinkKapazitaetstopf(topfData) {
    // 1. Neuen Topf erstellen und initial speichern (um _id und TopfID zu bekommen)
    const neuerTopf = new Kapazitaetstopf(topfData);
    await neuerTopf.save();
    console.log(`Neuer Kapazitätstopf ${neuerTopf.TopfID || neuerTopf._id} initial gespeichert.`);

    // 2. Nachbarn suchen
    let finalerTopf = findAndLinkLogic(neuerTopf);

    return finalerTopf;
};

// Exportiere die Funktion(en), die von außerhalb gebraucht werden
module.exports = {
    createAndLinkKapazitaetstopf, findAndLinkLogic
};