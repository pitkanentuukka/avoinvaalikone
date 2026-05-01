# Kysymyssarjojen lähetys- ja hyväksyntäprosessi

Tämä dokumentti kuvaa koko prosessin siitä, kun järjestö (NGO) lähettää kysymyssarjan, siihen kun se joko hyväksytään ja julkaistaan tai hylätään. Kaikki mahdolliset polut on kuvattu.

---

## 1. Järjestö lähettää kysymyssarjan

**Päätepiste:** `POST /api/question-sets`

Järjestö täyttää lomakkeen ja lähettää kysymyssarjan. Seuraavat kentät vaaditaan tai ovat valinnaisia:

| Kenttä | Pakollinen | Rajoitukset |
|--------|-----------|-------------|
| `ngoName` (järjestön nimi) | Kyllä | Maks. 255 merkkiä |
| `title` (otsikko) | Kyllä | Maks. 255 merkkiä |
| `ngoEmail` (sähköposti) | Ei | Maks. 255 merkkiä, oltava validi sähköpostiosoite |
| `logoUrl` (logon URL) | Ei | Maks. 500 merkkiä, oltava `http://` tai `https://` |
| `questions` (väittämät) | Kyllä, ≥ 1 | Maks. 50 väittämää; kukin maks. 500 merkkiä |

Tyhjät tai yli 500 merkin väittämät jätetään hiljaisesti pois — muut tallennetaan.

**Validointivirheet (HTTP 400):**
- Järjestön nimi tai otsikko puuttuu
- Kenttä ylittää pituusrajan
- Sähköpostiosoite tai URL on virheellisessä muodossa
- Väittämälista on tyhjä tai puuttuu

**Onnistunut tallennus:**
- Kysymyssarja tallennetaan tietokantaan tilassa `pending` (`hidden = false`)
- Vastauksena palautetaan luotu kysymyssarja väittämineen (HTTP 201)
- Ylläpidolle lähetetään sähköposti-ilmoitus (`ADMIN_EMAIL`), jos SMTP on konfiguroitu

**Nopeusrajoitus:** 20 pyyntöä / 15 min (ei koske kehitysympäristöä)

---

## 2. Ylläpidon käsittelyvaihtoehdot

Ylläpito näkee kaikki kysymyssarjat tilasta riippumatta (`GET /api/admin/question-sets`), järjestyksessä: `pending` ensin, sitten `approved`, lopuksi `rejected`.

Ylläpidolla on neljä tapaa käsitellä `pending`-tilassa oleva kysymyssarja:

---

### Polku A — Koko kysymyssarjan hyväksyminen

**Päätepiste:** `PATCH /api/admin/question-sets/:id/approve`

Kaikki väittämät hyväksytään sellaisenaan.

**Mitä tapahtuu:**
1. Tila päivittyy: `pending` → `approved`, `reviewed_at` asetetaan, `hidden = false`
2. Kysymyssarja on välittömästi julkinen äänestäjille
3. Sähköposti-ilmoitukset lähetetään:
   - Järjestölle: "Kysymyssarjanne on hyväksytty: [otsikko]"
   - Kaikille ehdokkaille, joilla on sähköposti ja jo annettuja vastauksia: ilmoitus uusista kysymyksistä ja linkki vastauslomakkeelle
   - Kaikille puolueille, joiden ehdokkaille on annettuja vastauksia: ilmoitus ja linkki puolueportaaliin

---

### Polku B — Koko kysymyssarjan hylkääminen

**Päätepiste:** `PATCH /api/admin/question-sets/:id/reject`

Koko kysymyssarja hylätään.

**Mitä tapahtuu:**
1. Tila päivittyy: `pending` → `rejected`, `reviewed_at` asetetaan
2. Kysymyssarja ei näy äänestäjille
3. Sähköposti-ilmoitus järjestölle (jos sähköposti annettu): "Kysymyssarjanne on valitettavasti hylätty"

---

### Polku C — Osittainen käsittely (väittämäkohtainen hyväksyntä/hylkäys/muokkaus)

**Päätepiste:** `PATCH /api/admin/question-sets/:id/review`

Ylläpito voi käsitellä väittämät yksitellen: hyväksyä sellaisenaan, muokata tai hylätä.

**Pyyntörakenne:**
```json
{
  "reviews": [
    { "questionId": "<uuid>" },
    { "questionId": "<uuid>", "editedStatement": "Muokattu väittämäteksti" },
    { "questionId": "<uuid>", "rejected": true, "rejectionReason": "Valinnainen perustelu" }
  ]
}
```

Väittämät, joille ei anneta toimintoa lainkaan (ei `rejected`, ei `editedStatement`), hyväksytään sellaisinaan.

**Mitä tapahtuu:**
1. Muokatut väittämät päivitetään tietokantaan
2. Hylätyt väittämät poistetaan tietokannasta
3. Tilanne jäljellä olevien väittämien mukaan:

| Jäljellä olevia väittämiä | Uusi tila | `hidden` |
|--------------------------|-----------|----------|
| ≥ 1 | `approved` | `true` (piilotettu, odottaa julkaisua) |
| 0 (kaikki hylätty) | `rejected` | ei muutu |

4. Sähköposti järjestölle (jos sähköposti annettu):
   - Jos kaikki hylätty: "Kysymyssarjanne on valitettavasti hylätty kokonaan"
   - Muuten: eritelty yhteenveto hyväksytyistä, muokatuista ja hylätyistä väittämistä, sekä tieto että ylläpito voi vielä muokata ennen julkaisua

> **Huom:** Osittaisen käsittelyn jälkeen hyväksytty kysymyssarja on tilassa `approved` mutta **piilotettu** (`hidden = true`). Se ei vielä näy äänestäjille — katso Polku D.

---

### Polku D — Piilotetun kysymyssarjan muokkaus ja julkaisu

Tätä polkua käytetään Polun C jälkeen, kun kysymyssarja on `approved` mutta `hidden = true`. Ylläpito voi viimeistellä sisällön ennen julkaisua.

#### D.1 — Väittämien lisääminen

**Päätepiste:** `POST /api/admin/question-sets/:id/questions`

Toimii vain kun `status = 'approved'` ja `hidden = true`.

```json
{ "statement": "Uusi väittämäteksti" }
```

#### D.2 — Väittämien poistaminen

**Päätepiste:** `DELETE /api/admin/question-sets/:id/questions/:questionId`

Toimii vain kun `status = 'approved'` ja `hidden = true`.

#### D.3 — Julkaisu

**Päätepiste:** `PATCH /api/admin/question-sets/:id/unhide`

Asettaa `hidden = false`, jolloin kysymyssarja tulee äänestäjille näkyväksi.

**Sähköposti-ilmoitukset julkaisun yhteydessä:**
- Järjestölle: "Kysymyssarjanne on julkaistu: [otsikko]" (sisältää väittämien lukumäärän)
- Kaikille ehdokkaille, joilla on sähköposti ja jo annettuja vastauksia
- Kaikille puolueille, joiden ehdokkaille on annettuja vastauksia

#### D.4 — Piilottaminen uudelleen

**Päätepiste:** `PATCH /api/admin/question-sets/:id/hide`

Asettaa `hidden = true`. Käytettävissä myös jo julkaistuille sarjoille, jos ne halutaan ottaa pois näkyvistä. Ei lähetä ilmoituksia.

---

## 3. Poistaminen

**Päätepiste:** `DELETE /api/admin/question-sets/:id`

Kysymyssarjan voi poistaa kokonaan tilasta riippumatta. Kaikki siihen liittyvät väittämät poistetaan samalla. Ei lähetä ilmoituksia.

---

## 4. Tilakaavio

```
                    ┌─────────┐
                    │ pending │  ← Järjestö lähettää
                    └────┬────┘
                         │
           ┌─────────────┼──────────────┐
           │             │              │
           ▼             ▼              ▼
     Polku A:        Polku B:       Polku C:
     /approve        /reject        /review
           │             │              │
           ▼             ▼        ┌─────┴──────┐
       approved       rejected    │            │
      hidden=false               Kaikki      Osa
                                hylätty    jäljellä
                                  │            │
                                  ▼            ▼
                               rejected     approved
                                           hidden=true
                                                │
                                    ┌───────────┼──────────┐
                                    │           │          │
                                    ▼           ▼          ▼
                              Lisää väittämiä  Poista   /unhide
                              /questions       /questions/:qId
                                                          │
                                                          ▼
                                                       approved
                                                      hidden=false
                                                    (julkinen äänestäjille)
                                                          │
                                                          ▼
                                                       /hide
                                                      (piilottaa uudelleen)
```

---

## 5. Sähköposti-ilmoitusten yhteenveto

| Tapahtuma | Vastaanottaja |
|-----------|--------------|
| Järjestö lähettää kysymyssarjan | Ylläpito (`ADMIN_EMAIL`) |
| Koko sarja hyväksytään (`/approve`) | Järjestö, ehdokkaat, puolueet |
| Koko sarja hylätään (`/reject`) | Järjestö |
| Osittainen käsittely (`/review`) | Järjestö |
| Sarja julkaistaan (`/unhide`) | Järjestö, ehdokkaat, puolueet |

Ilmoitukset lähetetään vain jos SMTP on konfiguroitu (`SMTP_HOST`). Järjestölle lähetetään ilmoitus vain jos `ngoEmail` on annettu. Ehdokas- ja puolue-ilmoitukset lähetetään vain niille, joilla on sähköpostiosoite ja jo annettuja vastauksia.
