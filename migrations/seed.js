const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ─── Parties ───
    const { rows: parties } = await client.query(`
      INSERT INTO parties (name, token, email) VALUES
        ('Sosialidemokraatit', 'sd-2026-x7k9',  'sihteeri@sdp.fi'),
        ('Kokoomus',           'nc-2026-m3p1',  'sihteeri@kokoomus.fi'),
        ('Vihreät',            'gl-2026-q8w2',  'sihteeri@vihreat.fi')
      ON CONFLICT (name) DO NOTHING
      RETURNING id, name, token
    `);

    const partyMap = {};
    parties.forEach((p) => (partyMap[p.token] = p.id));
    console.log(`✓ Inserted ${parties.length} parties`);

    // ─── Question Sets ───
    const { rows: sets } = await client.query(`
      INSERT INTO question_sets (ngo_name, ngo_email, logo_url, title, status) VALUES
        ('Ilmastotoimintaverkosto', 'info@ilmastotoiminta.fi',
         'https://img.icons8.com/color/96/globe--v1.png',
         'Ilmasto- ja energiapolitiikka', 'approved'),
        ('Koulutus Ensin ry', 'yhteystiedot@koulutusensin.fi',
         'https://img.icons8.com/color/96/graduation-cap.png',
         'Koulutus ja tutkimus', 'approved'),
        ('Digitaaliset Oikeudet ry', 'hei@digioikeudet.fi',
         'https://img.icons8.com/color/96/security-checked.png',
         'Digitaaliset oikeudet ja tekoäly', 'pending')
      RETURNING id, title
    `);
    console.log(`✓ Inserted ${sets.length} question sets`);

    // ─── Questions ───
    const climateSetId = sets.find((s) => s.title.includes("Ilmasto")).id;
    const eduSetId = sets.find((s) => s.title.includes("Koulutus")).id;
    const digitalSetId = sets.find((s) => s.title.includes("Digitaaliset")).id;

    const { rows: questions } = await client.query(
      `
      INSERT INTO questions (question_set_id, statement, sort_order) VALUES
        ($1, 'Suomen tulee saavuttaa hiilineutraalius vuoteen 2030 mennessä, vaikka se nostaisi energian hintaa.', 1),
        ($1, 'Ydinenergiaa tulee laajentaa osana vihreää siirtymää.', 2),
        ($1, 'Tuontihiilitulli tulee ottaa käyttöön kotimaisen teollisuuden suojelemiseksi.', 3),
        ($1, 'Fossiilisten polttoaineiden tuet tulee poistaa välittömästi.', 4),

        ($2, 'Yliopisto-opetuksen tulee pysyä maksuttomana kaikille EU-kansalaisille.', 1),
        ($2, 'Julkista T&K-rahoitusta tulee nostaa 4 prosenttiin BKT:stä.', 2),
        ($2, 'Ammatillisen koulutuksen rahoituksen tulee olla samalla tasolla akateemisten opintojen kanssa.', 3),

        ($3, 'Julkishallinnossa käytettävien tekoälyjärjestelmien tulee olla täysin läpinäkyviä ja tarkastettavia.', 1),
        ($3, 'Kansalaisilla tulee olla oikeus kieltäytyä algoritmisesta päätöksenteosta.', 2),
        ($3, 'Sosiaalisen median alustojen tulee olla juridisessa vastuussa haitallisen sisällön algoritmisesta vahvistamisesta.', 3)
      RETURNING id, question_set_id, sort_order
    `,
      [climateSetId, eduSetId, digitalSetId]
    );
    console.log(`✓ Inserted ${questions.length} questions`);

    // Helper to find question id by set + order
    const qId = (setId, order) =>
      questions.find(
        (q) => q.question_set_id === setId && q.sort_order === order
      ).id;

    // ─── Candidates ───
    const { rows: candidates } = await client.query(
      `
      INSERT INTO candidates (party_id, name, photo_url, bio) VALUES
        ($1, 'Anna Virtanen',  'https://i.pravatar.cc/200?img=49',
         'Kansanedustaja Helsingistä. Erityisalueina sosiaalipolitiikka, koulutus ja tasa-arvo. Olen toiminut kuntapolitiikassa 10 vuotta ennen eduskuntaan siirtymistä.'),
        ($2, 'Mikko Korhonen', 'https://i.pravatar.cc/200?img=12',
         'Yrittäjä ja talousasiantuntija Tampereelta. Uskon vastuulliseen markkinatalouteen ja yrittäjyyden vahvistamiseen. Tavoitteenani on kilpailukykyinen Suomi.'),
        ($3, 'Liisa Mäkelä',  'https://i.pravatar.cc/200?img=45',
         'Ympäristöaktivisti ja kaupunginvaltuutettu Turusta. Taistelen ilmastokriisiä vastaan ja puolustan luonnon monimuotoisuutta. Koulutukseltani ympäristötieteilijä.'),
        ($1, 'Jari Niemi',    'https://i.pravatar.cc/200?img=53',
         'Ammattiyhdistysaktivisti ja työoikeuden asiantuntija Oulusta. Puolustan työntekijöiden oikeuksia ja reilua työelämää kaikille suomalaisille.')
      RETURNING id, name
    `,
      [partyMap["sd-2026-x7k9"], partyMap["nc-2026-m3p1"], partyMap["gl-2026-q8w2"]]
    );
    console.log(`✓ Inserted ${candidates.length} candidates`);

    const cId = (name) => candidates.find((c) => c.name === name).id;

    // ─── Answers ───
    // Anna Virtanen (SDP)
    const answerRows = [
      // Anna
      [cId("Anna Virtanen"), qId(climateSetId, 1), 4, "Ilmastoneutraalius on kiireellinen tavoite, mutta meidän on varmistettava oikeudenmukainen siirtymä työntekijöille."],
      [cId("Anna Virtanen"), qId(climateSetId, 2), 2, "Ydinvoimalla voi olla rooli, mutta se ei saa hallita energiapalettia."],
      [cId("Anna Virtanen"), qId(climateSetId, 3), 3, "Tuemme EU:n politiikan mukaisia hiilitulleja."],
      [cId("Anna Virtanen"), qId(climateSetId, 4), 4, "Tukien poistaminen on välttämätöntä, mutta siirtymätuki yhteisöille tarvitaan."],
      [cId("Anna Virtanen"), qId(eduSetId, 1), 4, "Maksuton koulutus on pohjoismaisen yhteiskunnan kulmakivi."],
      [cId("Anna Virtanen"), qId(eduSetId, 2), 3, "Tuemme korotuksia, mutta tasapaino muiden menojen kanssa on säilytettävä."],
      [cId("Anna Virtanen"), qId(eduSetId, 3), 4, "Ehdottomasti. Ammatilliset opintopolut ovat taloudelle välttämättömiä."],
      // Mikko
      [cId("Mikko Korhonen"), qId(climateSetId, 1), 1, "Vuosi 2030 on epärealistinen. Tarvitsemme käytännöllisen aikataulun, joka suojaa kilpailukykyä."],
      [cId("Mikko Korhonen"), qId(climateSetId, 2), 4, "Ydinvoima on puhdasta, luotettavaa ja välttämätöntä energiaomavaraisuudelle."],
      [cId("Mikko Korhonen"), qId(climateSetId, 3), 3, "Kannatamme periaatteessa, mutta toteutus ei saa rasittaa pk-yrityksiä."],
      [cId("Mikko Korhonen"), qId(climateSetId, 4), 1, "Äkillinen poistaminen vaarantaisi energiaturvallisuuden. Asteittainen luopuminen on parempi."],
      [cId("Mikko Korhonen"), qId(eduSetId, 1), 2, "Harkitaan maltillisia maksuja EU:n ulkopuolisille opiskelijoille laadun parantamiseksi."],
      [cId("Mikko Korhonen"), qId(eduSetId, 2), 3, "T&K-investoinnit edistävät innovaatiota. Tuemme kohdennettuja korotuksia."],
      [cId("Mikko Korhonen"), qId(eduSetId, 3), 3, "Tärkeää, mutta rahoituksen tulee seurata työmarkkinoiden kysyntää."],
      // Liisa
      [cId("Liisa Mäkelä"), qId(climateSetId, 1), 4, "Meidän pitäisi tähdätä vuoteen 2028. Ilmastokriisi vaatii kiireellisyyttä."],
      [cId("Liisa Mäkelä"), qId(climateSetId, 2), 0, "Ydinvoima on liian hidasta ja kallista. Investoidaan uusiutuviin sen sijaan."],
      [cId("Liisa Mäkelä"), qId(climateSetId, 3), 4, "Välttämätön hiilivuodon estämiseksi ja vihreän tuotannon kannustamiseksi."],
      [cId("Liisa Mäkelä"), qId(climateSetId, 4), 4, "Eilen oli liian myöhään. Ohjataan tuet uusiutuvaan energiaan."],
      [cId("Liisa Mäkelä"), qId(eduSetId, 1), 4, "Koulutus on ihmisoikeus, ei kauppatavaraa."],
      [cId("Liisa Mäkelä"), qId(eduSetId, 2), 4, "Tutkimus on kestävän tulevaisuuden perusta."],
      [cId("Liisa Mäkelä"), qId(eduSetId, 3), 4, "Erityisesti vihreiden taitojen koulutus ammatillisessa koulutuksessa on kriittistä."],
      // Jari
      [cId("Jari Niemi"), qId(climateSetId, 1), 3, "Kunnianhimoinen mutta saavutettavissa oikealla teollisuuspolitiikalla."],
      [cId("Jari Niemi"), qId(climateSetId, 2), 3, "Suhtaudun ydinvoimaan käytännönläheisesti osana monipuolista energiapalettia."],
      [cId("Jari Niemi"), qId(climateSetId, 3), 4, "Vahva tuki. Tämä suojaa sekä ilmastoa että suomalaisia työpaikkoja."],
      [cId("Jari Niemi"), qId(climateSetId, 4), 3, "Luovutaan 3–5 vuodessa työntekijöiden uudelleenkoulutusohjelmien kera."],
      [cId("Jari Niemi"), qId(eduSetId, 1), 4, "Ehdoton. Koulutuksen tasa-arvo määrittää, keitä me olemme."],
      [cId("Jari Niemi"), qId(eduSetId, 2), 4, "Innovaatiomenot ovat investointeja, eivät kuluja."],
      [cId("Jari Niemi"), qId(eduSetId, 3), 3, "Tuen tasavertaisuutta, mutta myös ammatillisten opetussuunnitelmien modernisointia."],
    ];

    for (const [candidateId, questionId, value, explanation] of answerRows) {
      await client.query(
        `INSERT INTO candidate_answers (candidate_id, question_id, value, explanation)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (candidate_id, question_id) DO UPDATE SET value = $3, explanation = $4`,
        [candidateId, questionId, value, explanation]
      );
    }
    console.log(`✓ Inserted ${answerRows.length} candidate answers`);

    await client.query("COMMIT");
    console.log("\n✓ Seed completed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("✗ Seed failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
