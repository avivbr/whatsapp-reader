                                                

/**
 * Resolve phone numbers to the names WhatsApp knows them by.
 *
 * The bridge is lid.ZWAZACCOUNT, which maps a phone number to the @lid privacy
 * identifier used in group messages. Without it, anyone absent from the address
 * book is unreachable: their name only exists as a push name keyed by @lid.
 *
 * ZWAZACCOUNT.ZDISPLAYNAME looks useful and is not -- it holds a masked number
 * ("+972*******20"), not a name.
 */

                              
                 
                 
                             
                          
                           
                          
                     
 

const digits = (value        ) => value.replace(/\D/g, "");

export function resolvePhone(db              , rawNumber        )              {
  const number = digits(rawNumber);
  const jid = `${number}@s.whatsapp.net`;

  const lidRow = db
    .prepare("SELECT ZIDENTIFIER i FROM lid.ZWAZACCOUNT WHERE ZPHONENUMBER = ? LIMIT 1")
    .get(number)                              ;
  const lid = lidRow?.i ?? null;

  const text = (row                                     , key        )                => {
    const value = row?.[key];
    return typeof value === "string" && value !== "" ? value : null;
  };

  // Address book, tried by JID, then normalised phone, then @lid.
  const contact =
    text(
      db
        .prepare(
          "SELECT ZFULLNAME n FROM contacts.ZWAADDRESSBOOKCONTACT " +
            "WHERE ZFULLNAME <> '' AND ZWHATSAPPID = ? LIMIT 1",
        )
        .get(jid)                                       ,
      "n",
    ) ??
    text(
      db
        .prepare(
          "SELECT ZFULLNAME n FROM contacts.ZWAADDRESSBOOKCONTACT " +
            "WHERE ZFULLNAME <> '' AND replace(replace(ZPHONENUMBER,'+',''),'-','') = ? LIMIT 1",
        )
        .get(number)                                       ,
      "n",
    ) ??
    (lid
      ? text(
          db
            .prepare(
              "SELECT ZFULLNAME n FROM contacts.ZWAADDRESSBOOKCONTACT " +
                "WHERE ZFULLNAME <> '' AND ZLID = ? LIMIT 1",
            )
            .get(lid)                                       ,
          "n",
        )
      : null);

  const pushFor = (key        ) =>
    text(
      db
        .prepare("SELECT ZPUSHNAME n FROM ZWAPROFILEPUSHNAME WHERE ZJID = ? AND ZPUSHNAME <> '' LIMIT 1")
        .get(key)                                       ,
      "n",
    );
  const pushName = pushFor(jid) ?? (lid ? pushFor(lid) : null);

  const titleFor = (key        ) =>
    text(
      db
        .prepare(
          "SELECT ZPARTNERNAME n FROM ZWACHATSESSION " +
            "WHERE ZSESSIONTYPE = 0 AND ZCONTACTJID = ? AND ZPARTNERNAME <> '' LIMIT 1",
        )
        .get(key)                                       ,
      "n",
    );
  const chatTitle = titleFor(jid) ?? (lid ? titleFor(lid) : null);

  const bestName = contact ?? pushName ?? chatTitle ?? null;
  return { number, found: bestName !== null, contactName: contact, pushName, chatTitle, bestName, lid };
}

export function resolvePhones(db              , numbers                   )                {
  return numbers.map((n) => resolvePhone(db, n));
}
