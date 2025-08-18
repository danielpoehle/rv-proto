const { differenceInCalendarWeeks, parseISO, startOfWeek, startOfUTCDay } = require('date-fns');


// Globale Konstante für den Start der allerersten relativen Kalenderwoche (KW 1)
// JavaScript Monate sind 0-indiziert (Dezember = 11)
const GLOBAL_KW1_START_DATE_ISO = "2024-12-30T00:00:00.000Z"; // Montag, 30. Dezember 2024
const GLOBAL_KW1_START_DATE = startOfWeek(parseISO(GLOBAL_KW1_START_DATE_ISO), { weekStartsOn: 1 });

// Hilfsfunktion: Berechnet die globale relative Kalenderwoche eines Datums
function getGlobalRelativeKW(currentDateStr) {
    try {
        const currentDate = parseISO(currentDateStr.toISOString ? currentDateStr.toISOString() : currentDateStr); // Akzeptiert Date-Objekt oder ISO-String

        


        const startOfCurrentDateWeek = startOfWeek(currentDate, { weekStartsOn: 1 });

        //console.log(`currentDate ${currentDate} startOfCurrentDateWeek ${startOfCurrentDateWeek} return ${differenceInCalendarWeeks(startOfCurrentDateWeek.toISOString(), GLOBAL_KW1_START_DATE.toISOString(), { weekStartsOn: 1 }) + 1}`);

        if (startOfCurrentDateWeek < GLOBAL_KW1_START_DATE) {
            // Datum liegt vor dem Start des globalen Kalendersystems
            return null; // Oder Fehler werfen, je nach Anforderung
        }
        
        return (differenceInCalendarWeeks(startOfCurrentDateWeek, GLOBAL_KW1_START_DATE, { weekStartsOn: 1 }) + 1);
    } catch (e) {
        console.error("Fehler in getGlobalRelativeKW für Datum:", currentDateStr, e);
        return null;
    }
}

// Exportiere die Funktion(en), die von außerhalb gebraucht werden
module.exports = {
    GLOBAL_KW1_START_DATE_ISO, GLOBAL_KW1_START_DATE, getGlobalRelativeKW
};