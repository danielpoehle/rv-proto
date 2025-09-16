const { Slot, TagesSlot, NachtSlot } = require('../models/Slot');
const { findOrCreateKapazitaetstopf, updateTopfSlotsAndCapacity } = require('../utils/slotController.helpers');

/**
 * Erstellt ein einzelnes Slot-Dokument (Tag oder Nacht), generiert die sprechende ID,
 * findet/erstellt den zugehörigen Kapazitätstopf und aktualisiert die Verknüpfungen.
 * @param {object} slotData - Die Daten für den zu erstellenden Slot. Muss `slotTyp` ('TAG' oder 'NACHT') enthalten.
 * @returns {Promise<Document>} Das erstellte und gespeicherte Slot-Dokument.
 */
async function createSingleSlot(slotData) {
    // 1. Finde oder erstelle den passenden Kapazitätstopf
    const potenziellerTopf = await findOrCreateKapazitaetstopf(slotData);
    
    const dataToSave = {
        ...slotData,
        VerweisAufTopf: potenziellerTopf ? potenziellerTopf._id : null
    };

    // 2. Erstelle die korrekte Instanz basierend auf dem Typ
    let neuerSlot;
    if (slotData.slotTyp === 'NACHT') {
        neuerSlot = new NachtSlot(dataToSave);
    } else { // 'TAG' ist der Standard
        neuerSlot = new TagesSlot(dataToSave);
    }

    // 3. Speichern (löst den pre-save Hook für die SlotID_Sprechend aus)
    const gespeicherterSlot = await neuerSlot.save();

    // 4. Bidirektionale Verknüpfung im Kapazitätstopf aktualisieren
    if (gespeicherterSlot.VerweisAufTopf) {
        await updateTopfSlotsAndCapacity(gespeicherterSlot.VerweisAufTopf, gespeicherterSlot._id, 'add');
    }

    //console.log("finished function createSingleSlot")

    return gespeicherterSlot;
}

/**
 * Erstellt eine komplette Slot-Gruppe (1 Eltern-Teil und 1..n Kind-Teile).
 * @param {object} gruppenData - Daten für die Slot-Gruppe, inkl. `alternativen`-Array.
 * @returns {Promise<Document>} Das erstellte und populierte Eltern-Slot-Dokument.
 */
async function createSlotGruppe(gruppenData) {
    const { elternSlotTyp, alternativen, ...gemeinsameDaten } = gruppenData;

    //console.log(`elternSlotTyp ${elternSlotTyp}, alternativen ${alternativen}, gemeinsameDaten ${gemeinsameDaten}`);

    if (!alternativen || alternativen.length === 0) {
        throw new Error('Eine Slot-Gruppe muss mindestens eine Alternative enthalten.');
    }
    //0. Validierung ob slotTyp gesetzt wurde --> TODO
        // if(!slotTyp){
        //     return res.status(400).json({ message: 'Bitte slotTyp setzen.' });
        // }

        // // 1. Validierung der Eingabedaten
        // if(slotTyp === 'TAG'){
        //     if (!von || !bis || !Abschnitt || !Abfahrt || !Ankunft || !Verkehrstag || !Grundentgelt || !Verkehrsart || !Kalenderwoche ) {                
        //         return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung (Tag) ausfüllen.' });
        //     }
        // }else{ // Nacht-Slot
        //     if (!von || !bis || !Abschnitt || !Zeitfenster || !Mindestfahrzeit || !Verkehrstag || !Grundentgelt || !Maximalfahrzeit || !Kalenderwoche ) {
        //         return res.status(400).json({ message: 'Bitte alle erforderlichen Felder für die Massenerstellung (Nacht) ausfüllen.' });
        //     }
        // }        

        // if(!['Mo-Fr', 'Sa+So'].includes(Verkehrstag)){
        //     return res.status(400).json({ message: 'Verkehrstag Mo-Fr oder Sa+So ist nur zulässig' });
        // }

    // 1. Erstelle alle Kind-Slots
    const kindPromises = alternativen.map((alt) => {
        const kindData = {
            slotTyp: elternSlotTyp,
            ...gemeinsameDaten, // Erbt KW, Verkehrstag, Linienbezeichnung
            ...alt,             // Spezifische Daten wie von, bis, Zeiten
            slotStrukturTyp: 'KIND'
        };
        
        const KindModell = elternSlotTyp === 'TAG' ? TagesSlot : NachtSlot;
        return new KindModell(kindData).save();        
    });
    

    const erstellteKinder = await Promise.all(kindPromises);
    const kinderIds = erstellteKinder.map(k => k._id);

    // 2. Erstelle den Eltern-Slot
    const elternSlot = new Slot({
        ...gemeinsameDaten,
        slotStrukturTyp: 'ELTERN',
        elternSlotTyp: elternSlotTyp,
        gabelAlternativen: kinderIds,
        // Felder wie von, bis, Abfahrt etc. existieren hier nicht
    });    
    
    // 3. Finde den Kapazitätstopf (basierend auf dem ersten Kind) und verknüpfe ihn mit dem ELTERN-Slot
    const repraesentativesKind = { slotTyp: elternSlotTyp, ...gemeinsameDaten, ...alternativen[0] };    
    const potenziellerTopf = await findOrCreateKapazitaetstopf(repraesentativesKind);
    if (potenziellerTopf) {
        elternSlot.VerweisAufTopf = potenziellerTopf._id;
    }    
    
    await elternSlot.save();

    // 4. Verknüpfe die Kinder zurück zum Eltern-Teil
    await Slot.updateMany(
        { _id: { $in: kinderIds } },
        { $set: { gabelElternSlot: elternSlot._id } }
    );
    
    // 5. Füge den ELTERN-Slot zum Kapazitätstopf hinzu
    if (potenziellerTopf) {
        await updateTopfSlotsAndCapacity(potenziellerTopf._id, elternSlot._id, 'add');
    }

    // Gib den voll-populierten Eltern-Slot zurück
    return Slot.findById(elternSlot._id).populate('gabelAlternativen');
}

module.exports = {
    createSingleSlot,
    createSlotGruppe
};