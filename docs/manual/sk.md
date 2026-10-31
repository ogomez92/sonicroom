---
title: Používanie SonicRoom s čítačom obrazovky
subtitle: Ako si nastaviť čítač obrazovky, ako funguje klávesnica a všetky klávesové skratky
lang: sk
---

# Najprv si prečítajte túto časť

**SonicRoom je aplikácia, nie webová stránka.**

Táto jediná veta vysvetľuje takmer všetky problémy, na ktoré ľudia narážajú. SonicRoom síce beží v prehliadači, ale nič v ňom sa nespráva ako článok, aký bežne čítate. Nie je tu dokument, po ktorom by ste sa posúvali. Sú tu panely nástrojov, zoznamy a dialógové okná a ovládajú sa tak, ako sa ovládajú klasické aplikácie určené pre počítač: **Stlačením klávesu Tab sa presúvate medzi jednotlivými časťami, šípky sa používajú na pohyb vnútri časti**.

Čítače obrazovky to samy od seba nevedia. Vo východiskovom nastavení vám NVDA, JAWS, Narrator aj Orca predkladajú _virtuálnu kópiu_ stránky a zachytávajú vaše klávesy, takže `H` skočí na nadpis a `B` na tlačidlo. Na spravodajskom webe je to presne tak, ako to má byť, no tu je to presne nesprávne, pretože v SonicRoom `M` stlmí váš mikrofón, `R` spustí nahrávanie a `W` povie, kto práve hovoril. Ak čítač obrazovky tieto klávesy pohltí, do aplikácie sa nikdy nedostanú.

Preto prvá vec, ktorú treba urobiť — ešte predtým, než sa k čomukoľvek pripojíte — je prepnúť čítač obrazovky do režimu, v ktorom aplikácia dostáva vaše stlačenia klávesov. Každý čítač obrazovky ho nazýva inak. Nasledujúca časť vám povie, ako na to.

Ak si zapamätáte len jedno: **keď jediné písmeno nerobí nič, ste v nesprávnom režime.**

---

# Nastavenie čítača obrazovky

## NVDA

NVDA pozná dva režimy: **režim prehliadania** (browse mode) a **režim fokusu** (focus mode).

- Režim prehliadania je režim čítania. Jednotlivé písmená sú navigačné príkazy a na stránku sa nikdy nedostanú.
- Režim formulára posiela každé stlačenie klávesu priamo do aplikácie. Tento režim SonicRoom potrebuje.

**Prepínate ho skratkou `NVDA` + `Medzerník`.** Keď sa režim formulára zapne, začujete krátky nízky zvuk a pri návrate do režimu prehliadania vyšší. Niektoré hlasy tiež nahlas povedia „režim fokusu“ a „režim prehliadania“.

NVDA sa do režimu fokusu prepne automaticky vždy, keď sa dostanete na textové pole alebo podobný ovládací prvok, takže v ňom často budete, aj keď oň nepožiadate. Čo sa však neurobí automaticky, je prepnutie, keď stojíte na obyčajnom tlačidle — a práve vtedy chcete stlačiť niektorú skratku Sonic room ako sú `M` alebo `R`. Stlačte `NVDA` + `Medzerník` a zostaňte v režime fokusu počas celého hovoru.

Ak chcete, aby bolo automatické prepínanie NVDA voľnejšie, otvorte **ponuku NVDA → Možnosti → Nastavenia → Režim prehliadania** (alebo stlačte `NVDA` + `Ctrl` + `B`) a zapnite možnosti _Automaticky aktivovať režim fokusu pri zmene fokusu_ a _Automaticky aktivovať režim fokusu pri pohybe kurzorom_.

## JAWS

JAWS nazýva svoj režim čítania **virtuálny kurzor** (Virtual Cursor, niekedy „PC virtual cursor“) a svoj priamy režim **režim formulára** (Forms Mode).

**Pre SonicRoom odporúčame virtuálny kurzor úplne vypnúť: stlačte `Kláves JAWS` + `Z`** (klávesom JAWS je predvolene `Insert`, v rozložení pre notebook `Caps Lock`). JAWS oznámi „Virtuálny kurzor vypnutý“. Od tej chvíle putuje každý stlačený kláves do SonicRoom.

Môžete sa _spoliehať_ aj na automatický režim formulára — JAWS do režimu formulára prejde, keď na ovládacom prvku stlačíte `Enter`, a opustí ho klávesom `NumPad Plus`. Funguje to, ale tu vám to robí problémy z dvoch dôvodov: jednopísmenové príkazy SonicRoom nie sú pripojené k prvkom formulára, takže pre ne sa automatický režim formulárov nespustí; a SonicRoom používa kláves `Escape` na skutočnú prácu (zatvorenie panela textovej diskusie, zatvorenie dialógového okna, zastavenie prehrávaného súboru), ktorý môže režim formulára zadržať.

Vypnutie virtuálneho kurzora pomocou `Kláves JAWS` + `Z` sa vyhne obom problémom. Keď z hovoru odídete, rovnakou skratkou virtuálny kurzor aktivujete naspäť.

## Narrator (Windows)

Narrator nazýva svoj režim čítania **režim skenovania** (Scan Mode). **Vypnite** ho skratkou `Caps Lock` + `Medzerník`. Narrator oznámi „Scan off“. Keď je režim skenovania vypnutý, `Tab` a šípky sa správajú tak, ako opisuje táto príručka, a jednotlivé písmená sa dostanú do aplikácie.

## VoiceOver (macOS)

Podobnou pascou vo VoiceOveri je **Quick Nav**. Keď je Quick Nav zapnutý, šípky sú navigačné príkazy VoiceOveru a na stránku sa nikdy nedostanú.

**Quick Nav vypnete súčasným stlačením šípok doľava a doprava.** VoiceOver oznámi „Quick Nav off“.

Potom platí:

- `Tab` a `Shift` + `Tab` sa presúvajú medzi časťami aplikácie.
- Šípky sa pohybujú vnútri panela nástrojov alebo zoznamu, ako je opísané nižšie.
- Jednotlivé písmená (`M`, `A`, `R`, `W`…) sa dostanú do aplikácie SonicRoom, pokiaľ nie je zamerané textové pole.

`VO` v skratkách opísaných v nasledujúcich odsekoch nižšie znamená `Control` + `Option`. Možno budete musieť použiť `VO` + `Shift` + `šípka nadol`, aby ste vstúpili do skupiny webového obsahu, kým VoiceOver nasleduje fokus aplikácie.

## Orca (Linux)

Orca má pri webovom obsahu podobne ako NVDA **režim prehliadania** a **režim zameriavania**. Na ovládacích prvkoch formulára Orca prepína do režimu zameriavania automaticky; na ručné prepnutie stlačte `Orca` + `A` (modifikátorom Orca je `Insert` v rozložení pre stolový počítač a `Caps Lock` v rozložení pre notebook).

## iPhone, iPad a Android

SonicRoom funguje s čítačmi obrazovky VoiceOver, TalkBack a ostatnými na mobilných zariadeniach a každé tlačidlo v aplikácii SonicRoom, zoznam a dialóg majú výstižný textový popis. Jednoznakové klávesové skratky vyžadujú fyzickú klávesnicu, takže na dotykovej obrazovke používajte tlačidlá — všetko, čo ponúkajú klávesové skratky, je možné vyvolať aj zodpovedajúcim tlačidlom niekde na paneli nástrojov alebo v zozname používateľov.

V systéme iOS sa dve veci správajú inak: Safari nevie zobraziť video na celú obrazovku (aplikácia to povie nahlas namiesto toho, aby ponechala nefunkčné tlačidlo) a zvukový modul sa spustí až po tom, čo sa raz dotknete obrazovky, čo SonicRoom pri vašom prvom ťuknutí vybaví za vás.

## Desaťsekundový test, že máte všetko správne nastavené

Pripojte sa do miestnosti sami, uistite sa, že **nie je** zamerané vstupné pole v textovej diskusii, a stlačte `M`. Ak začujete zvuk stlmenia a „Mikrofón stlmený“, ste pripravení. Ak čítač obrazovky povie niečo o nadpise, zozname alebo „žiadny nasledujúci prvok“, stále ste v režime čítania — vráťte sa a prepnite čítač do správneho režimu.

---

# Ako funguje klávesnica všade v SonicRoom

Celú aplikáciu pokrývajú tri pravidlá.

**1. `Tab` sa presúva medzi časťami. Šípky sa pohybujú vnútri časti.**

Panel nástrojov s jedenástimi tlačidlami je _jedno_ zastavenie klávesu `Tab`, nie jedenásť. Zoznam dvadsiatich používateľov je tiež len jedno zastavenie klávesu `Tab`. Je to zámer: celou aplikáciou prejdete päť či šesť stlačeniami `Tab` namiesto štyridsiatich a presne tak fungujú desktopové aplikácie odjakživa. Zároveň to znamená, že stlačenie `Tab` vnútri panela nástrojov vás **nepresunie** na ďalšie tlačidlo — to urobí `šípka doprava`.

**2. Panely nástrojov: `šípka doľava` a `šípka doprava`.**

SonicRoom má dva panely nástrojov, oba v dolnej časti hovoru: ovládanie zvuku (vždy) a ovládanie videa (len vo videohovoroch). V ktoromkoľvek z nich platí:

| Kláves                 | Čo robí                                       |
| ---------------------- | --------------------------------------------- |
| `Šípka doprava`        | Ďalšie tlačidlo (z posledného cyklicky prechádza späť na prvé)   |
| `Šípka doľava`         | Predchádzajúce tlačidlo (z prvého cyklicky prechádza na posledné)|
| `Home`                 | Prvé tlačidlo                                 |
| `End`                  | Posledné tlačidlo                             |
| `Enter` alebo `Medzerník` | Stlačí tlačidlo, na ktorom stojíte         |
| `Tab`                  | Úplne opustí panel nástrojov                  |

**3. Zoznamy: `šípka nahor` a `šípka nadol`, potom `Enter`.**

Zoznam používateľov, história textovej diskusie, zoznam verejných miestností na recepcii a prehliadač súborov na serveri sú všetko zoznamy v rovnakom štýle:

| Kláves                          | Čo robí                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `Šípka nadol` / `Šípka nahor`   | Ďalšia / predchádzajúca položka                                                |
| `Home` / `End`                  | Prvá / posledná položka                                                        |
| `Enter` alebo `Medzerník`       | Otvorí alebo aktivuje položku                                                  |
| `Escape` alebo `Backspace`      | O úroveň späť (v možnostiach používateľa a v prehliadači súborov)                |

Čítač obrazovky oznámi každú položku, keď na ňu prejdete šípkou, spolu s jej stavom — stlmený, hovorí, zdieľa video a podobne.

**Posuvníky** (úroveň vášho mikrofónu, hlasitosť inej osoby) sa nachádzajú v zozname možností používateľa. Na posuvníku `šípka doľava` a `šípka doprava` menia hodnotu a vyslovia novú percentuálnu hodnotu; `Home` a `End` skočia na minimum a maximum. `Šípka nahor` a `šípka nadol` si ponechávajú obvyklú úlohu — presun na ďalšiu možnosť.

**`Escape` zatvára.** Panel textovej diskusie, nastavenia zvuku, nastavenia vysielania, výber zdroja zvuku, pole kľúča API, prehrávač súborov aj video na celú obrazovku sa zatvárajú klávesom `Escape` a fokus sa vráti na ovládací prvok, ktorým ste ich otvorili. Jedinou výnimkou je dialóg „niekto žiada o vstup“, na ktorý musíte odpovedať.

---

# Recepcia

Recepcia je prvá obrazovka aplikácie. Je to obyčajný formulár, takže ju môžete pokojne čítať v režime prehliadania, ak chcete — no zoznam verejných miestností sa obsluhuje šípkami, takže režim formulára je aj tak pohodlnejší.

Postupne zhora nadol:

1. **Jazyk** — rozbaľovací zoznam. Jeho zmena okamžite zmení všetky popisy, na recepcii aj v hovore, bez opätovného načítania.
2. **Názov miestnosti** — písmená, číslice, spojovníky a podčiarkovníky, najviac 64 znakov. Čokoľvek iné sa pri písaní odstráni. Ak v miestnosti s týmto názvom ešte nikto nie je, jeho napísaním ju vytvoríte.
3. **Typ miestnosti** — dva prepínače, **Hlasový hovor** a **Videohovor**. Predvolený je vždy hlasový hovor. Vyberáte šípkami. Toto rozhodnutie je trvalé počas celej existencie miestnosti a určuje, či kamery vôbec existujú.
4. **Pozadie videa** — zobrazí sa, len ak ste zvolili _Videohovor_. Pozri [Videohovory](#videohovory).
5. **Zobrazované meno** — meno, ktoré všetci začujú, keď sa pripojíte, prehovoríte alebo pošlete správu.
6. **Verejné miestnosti** — zoznam miestností, ktoré sú práve otvorené pre každého, s uvedením, kto v nich je. Zobrazuje sa, len ak aspoň jedna existuje. Šípkami prejdite na miestnosť a stlačte `Enter`, čím sa jej názov vyplní za vás; fokus sa vráti na Zobrazované meno, takže už len napíšete svoje meno.
7. **Úroveň mikrofónu** — tlačidlo **Test**, posuvník **Úroveň mikrofónu** a aktualizujúci sa indikátor úrovne. Po stlačení Test sa budete počuť (použite slúchadlá) a čítač obrazovky vám povie, keď sa úroveň posunie medzi hodnotami _ticho_, _nízka_, _dobrá_ a _vysoká_. Posuvník zvyšujte, kým nepovie dobrá. Táto úroveň sa prenesie do hovoru. Oplatí sa to urobiť raz — mnohé mikrofóny v notebookoch sú v predvolenom stave príliš tiché.
8. **Zakázať režim P2P** — začiarkavacie políčko. Pri dvoch ľuďoch vás SonicRoom bežne spojí priamo medzi sebou. Zaškrtnutím sa vždy použije sprostredkovanie cez server. Väčšina ľudí to nikdy nepotrebuje.
9. **Zverejniť túto miestnosť** — začiarkavacie políčko. Miestnosť sa zverejní a zapnú sa pravidlá pre vstup a hlasovanie o odstránení používateľa, opísané ďalej. Keď miestnosť raz niekto zverejní, zostane verejná, kým z nej neodídu všetci; neskoršie zrušenie zaškrtnutia to neovplyvní.
10. **Vstúpiť bez mikrofónu** — Začiarkavacie políčko. Môžete počúvať a používať textovú diskusiu a prehliadač nikdy nepožiada o povolenie mikrofónu. Ak mikrofón nemáte alebo žiadosť o povolenie odmietnete, v tomto režime skončíte tak či tak.
11. **Vstúpiť do miestnosti** — predvolené tlačidlo formulára. Funguje aj `Enter` z ktoréhokoľvek textového poľa.

---

# Miestnosť po častiach

## Hlavička

Číta názov miestnosti a názov tejto inštancie SonicRoom, potom prípadné značky — **VIDEO** pre videohovor, **REC** počas nahrávania hovoru, **LIVE** počas jeho vysielania — potom počet pripojených používateľov, potom tlačidlo **Otvoriť textovú diskusiu** (ktoré má v názve aj počet neprečítaných správ) a nakoniec rozbaľovací zoznam jazyka.

## Zoznam používateľov

Srdce aplikácie. Je to jeden zoznam, ktorý obsahuje **najprv vás, potom všetkých ostatných** a potom jeden riadok za každú ďalšiu vec, ktorá sa do miestnosti vysiela: prehrávanie hudby, zvuk zdieľanej obrazovky, súbor, ktorý niekto streamuje, ďalší mikrofón.

Každý riadok sa číta ako meno osoby a potom všetko, čo práve platí, napríklad:

> Ana (vy), stlmená, zdieľa video, stlačte Enter pre otvorenie možností tohto používateľa

Môžete počuť tieto údaje: _vy_, _len text_ (pripojený bez mikrofónu), _stlmený_, _hovorí_, _zdieľa video_, _zdieľa obrazovku_, _pripnutý_, _stlmený vami_ a počet hlasov, ak práve prebieha hlasovanie o odstránení daného používateľa.

Stlačením `Enter` na riadku otvoríte možnosti používateľa. Tým sa zoznam nahradí druhým zoznamom a `Escape` alebo `Backspace` vás vráti späť.

## Možnosti používateľa

Čo tu nájdete, závisí od toho, akú položku v zozname používateľov ste otvorili.

**Pre samého seba:**

- **Úroveň vášho mikrofónu** — posuvník. `Doľava`/`doprava` mení hodnotu, `Home`/`End` skáču na minimum a maximum. Je to zosilnenie použité predtým, než váš hlas opustí váš počítač, takže mení to, čo počujú všetci.
- **Opísať moje video** a **Pripnúť moje video** — len vo videohovoroch.

**Pre iného používateľa:**

- **Hlasitosť pre _meno_** — posuvník. Mení len to, čo počujete _vy_.
- **Stlmiť _meno_ pre mňa** / **Zrušiť stlmenie _meno_ pre mňa** — umlčí používateľa len pre vás. Stlmený používateľ nie je o tom informovaný. Popis tohoto tlačidla sa aktualizuje tak, aby informoval, čo sa stane pri najbližšom stlačení.
- **Pripnúť video používateľa _meno_** / **Pripnúť obrazovku používateľa _meno_** — len vo videohovoroch a ide výlučne o zmenu na vašej vlastnej obrazovke; pripnutý používateľ sa to nikdy nedozvie.
- **Opísať video osoby _meno_** / **Opísať obrazovku osoby _meno_** — len vo videohovoroch. Pozri [Videohovory](#videohovory).
- **Odstrániť používateľa _meno_** — len vo verejných miestnostiach s tromi alebo viacerými ľuďmi. Pozri [Verejné miestnosti, vstupovanie a hlasovanie](#verejné-miestnosti-vstupovanie-a-hlasovanie).
- **Odstrániť prehrávanie** — odstráni zdroj prehrávania hudby.
- **Zastaviť tento stream** — zastaví jeden zdieľaný súbor, zvuk zdieľanej obrazovky alebo ďalší mikrofón.

## Panel textovej diskusie

Otvoríte ho tlačidlom Otvoriť textovú diskusiu v hlavičke miestnosti. Panel je zámerne usporiadaný tak, že **najprv je história správ, potom textové pole určené na písanie správy**, aby ste sa zamerali na to, čo práve odznelo, a nie na prázdne textové pole.

- Zoznam správ je zoznam: Šípky `hore`/`dolu`, `Home`/`End`.
- `Ctrl` + `C` (alebo `Cmd` + `C`) na správe ju skopíruje.
- V poli správy `Enter` odošle a `Shift` + `Enter` začne nový riadok.
- **Oznamovať nové správy** je rozbaľovací zoznam v hlavičke panela so štyrmi nastaveniami: _Zdvorilo_ (vysloví sa, keď čítač obrazovky nabudúce urobí pauzu), _Naliehavo_ (preruší), _Nahlas_ (vlastný hlas prehliadača, pre ľudí, ktorí nepoužívajú čítač obrazovky) a _Vypnuté_.
- `Escape` zatvorí panel a vráti fokus na tlačidlo textovej diskusie.

Panel nemusíte mať stále otvorený. Všetko, čo sa v miestnosti deje, sa zapisuje do histórie textovej diskusie aj vyslovuje a `Alt` + číslo to prečíta späť odkiaľkoľvek — pozri [Počúvať, čo sa deje](#počúvať-čo-sa-deje).

## Panel nástrojov *Ovládacie prvky zvuku*

V dolnej časti okna. Jedno zastavenie klávesu `Tab`; `doľava`/`doprava` sa po ňom pohybujete. Poradie tlačidiel:

| Tlačidlo               | Skratka     | Čo robí                                                                                                                    |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| Stlmiť mikrofón        | `M`         | Stlmí a zruší stlmenie vášho mikrofónu. Zakázané, ale stále čitateľné, ak ste sa pripojili bez mikrofónu.                  |
| Zdieľať zvuk           | `A`         | Zdieľa zvuk obrazovky alebo karty prehliadača. Prehliadač sa opýta, ktorú, a musíte zaškrtnúť aj políčko „zdieľať zvuk“. |
| Prehrať zvuk zo súboru | `F`         | Otvorí výber zdroja: súbor z počítača, odkaz alebo súbor uložený na serveri.                                               |
| Automatické stišovanie   | `D`         | Zapne alebo vypne automatické zníženie hlasitosti prehrávanej hudby, aby bolo zreteľnejšie počuť hlasy, **pre celú miestnosť**.                                           |
| Nahrávať rozhovor           | `R`         | Spustí a zastaví nahrávanie všetkých na serveri.                                                                           |
| Stiahnuť nahrávku      | —           | Zobrazí sa, keď existuje nahrávka. Stiahne celý rozhovor zmiešaný dokopy.                                                     |
| Stiahnuť samostatné stopy | —           | Zobrazí sa, keď existuje nahrávka. Stiahne zip s jedným súborom pre každého používateľa, všetky zarovnané a doplnené na rovnakú dĺžku.    |
| Živé vysielanie        | —           | Otvorí panel, v ktorom zadáte údaje servera Icecast a spustíte vysielanie rozhovoru naň.                                      |
| Kto hovorí             | `W`         | Povie, kto hovorí práve teraz alebo nedávno hovoril, očíslovane.                                                           |
| Spoločné poznámky      | `Alt` + `N` | Otvorí spoločný poznámkový blok pre túto miestnost na novej karte. Prítomné len ak má táto inštancia funkciu nastavenú.       |
| Nastavenia zvuku       | —           | Výber mikrofónu a reproduktorov, spracovanie hlasu, Vysoká kvalita hlasu, ďalšie mikrofóny.                                          |
| Opustiť miestnosť        | —           | Opustí hovor a vráti vás na recepciu.                                                                                       |

## Pätička

Odkaz na projekt SonicRoom a odkaz na túto príručku.

---

# Všetky klávesové skratky

Fungujú kdekoľvek v hovore, **pokiaľ sa fokus klávesnice nenachádza v textovom poli** a váš čítač obrazovky posiela klávesy ďalej. Prestanú fungovať, keď je otvorený dialóg „niekto žiada o vstup“, pretože na ten treba najprv odpovedať.

## Jednotlivé písmená

| Kláves | Akcia                                                       |
| ------ | ----------------------------------------------------------- |
| `M`    | Stlmiť / zrušiť stlmenie mikrofónu                          |
| `A`    | Spustiť / zastaviť zdieľanie zvuku obrazovky alebo karty    |
| `F`    | Otvoriť výber „Prehrať zvuk zo súboru“                             |
| `D`    | Automatické stišovanie zap. / vyp. pre celú miestnosť         |
| `R`    | Spustiť / zastaviť nahrávanie                               |
| `W`    | Kto hovorí — oznámi nedávnych rečníkov, očíslovane          |
| `V`    | Kamera zap. / vyp. — **len videohovory**                    |
| `E`    | Video na celú obrazovku zap. / vyp. — **len videohovory**   |

`V` a `E` nerobia nič v zvukovom hovore, takže tieto písmená tam zostávajú voľné.

## S klávesom Alt

| Kláves                                  | Akcia                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `Alt` + `1` … `Alt` + `9`               | Prečíta posledné správy nahlas. `1` je najnovšia, `2` tá pred ňou a tak ďalej.        |
| `Alt` + `0`                             | Prečíta desiatu najnovšiu správu.                                                     |
| Rovnaké `Alt` + číslo dvakrát rýchlo    | Skopíruje danú správu do schránky.                                                    |
| `Alt` + `N`                             | Otvorí spoločné poznámky tejto miestnosti na novej karte.                              |
| `Ctrl` + `Shift` + `M`                  | Stlmí mikrofóny všetkých — **len moderované miestnosti** a len ak máte udelené oprávnenie.          |

Spätné čítanie pomocou `Alt` + číslo je jediná skupina skratiek, ktorá **funguje aj počas písania v poli textovej diskusie** a funguje, či je panel textovej diskusie otvorený, alebo zatvorený. Číta fyzické číselné klávesy, takže ju neovplyvní AZERTY, Dvorak ani žiadne iné rozloženie klávesnice.

## Navigácia a zatváranie

| Kláves                    | Akcia                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| `Tab` / `Shift` + `Tab`   | Presun medzi časťami aplikácie                                                 |
| `Doľava` / `Doprava`      | Pohyb po paneli nástrojov alebo zmena posuvníka                                |
| `Nahor` / `Nadol`         | Pohyb v zozname                                                               |
| `Home` / `End`            | Prvá / posledná položka v zozname alebo minimálna / maximálna hodnota posuvníka                      |
| `Enter` / `Medzerník`     | Aktivuje zameranú  položku                                                     |
| `Escape`                  | Zatvorí panel, dialóg alebo celú obrazovku                                     |
| `Backspace`               | Návrat z možností používateľa; o priečinok vyššie v prehliadači súborov servera  |
| `Enter`                   | Odošle správu v diskusii                                                       |
| `Shift` + `Enter`         | Nový riadok v správe v diskusii                                                |
| `Ctrl` / `Cmd` + `C`      | Skopíruje vybratú správu v diskusii                                             |

---

# Počúvať, čo sa deje

SonicRoom je navrhnutý na jednom pravidle: **všetko, čo sa v miestnosti oznámi, si môžete neskôr znova prečítať.**

Každá udalosť v miestnosti — niekto sa pripojil, niekto sa stlmil, začalo nahrávanie, začal sa prehrávať súbor, niekto bol odstránený — sa vysloví cez živú oblasť (live region) _a_ zapíše do histórie textovej diskusie ako systémová správa. Nič sa neoznámi len raz a nezmizne. Ak bol váš čítač obrazovky zaneprázdnený, písali ste alebo ste to jednoducho prepočuli, stlačte `Alt` + `1` a vypočujte si to ešte raz.

Tri veci sa vyslovia, ale zámerne sa _nezapisujú_ do histórie textovej diskusie, pretože sa týkajú vášho vlastného pohľadu, nie miestnosti: zmeny vašej lokálnej hlasitosti, stlmenie niekoho len pre seba a pripnutie videa. Nikoho iného sa netýkajú, a preto nepatria do spoločnej časovej osi.

**Zvukové signály.** Krátke zvuky sa prehrávajú pri stlmení, zrušení stlmenia, vstupe a opustení niekoho, novej správe v textovej diskusii, začatí alebo ukončení zdieľania, žiadosti niekoho vstúpiť do miestnosti, a zapnutí či vypnutí kamery. Sú lokálne — miestnosť ich nikdy nepočuje — a sú navrhnuté tak, aby sa dali odlíšiť od reči.

**„Kto hovorí“ (`W`).** Hlasy používateľov sa striedajú a čítač obrazovky ich nedokáže sledovať. Stlačte `W` a SonicRoom vymenuje ľudí, ktorí práve hovoria alebo hovorili v poslednom čase, očíslovane „1. Ana, 2. Luis, 3. Marta“ — od najnovšieho. Rovnaké čísla sa nakrátko zobrazia aj na ich dlaždiciach, takže vidiaca osoba vedľa vás vidí ten istý zoznam.

---

# Rozprávanie a počúvanie

**Stlmenie mikrofónu** vykonáte klávesom `M` alebo prvým tlačidlom na paneli nástrojov. Stlmenie sa týka len vášho hlasu. Ak súčasne prehrávate súbor, zdieľate zvuk obrazovky alebo máte spustené ďalšie mikrofóny, tie bežia ďalej — zastavíte ich príslušnými tlačidlami zastaviť, nie stlmením.

**Vašu vlastnú úroveň** nastavuje posuvník na vašej položke zoznamu používateľov a tiež posuvník na recepcii. Zvýšte ju, ak vám ľudia hovoria, že ste potichu.

**Úroveň niekoho iného** je posuvník na jeho položke zoznamu používateľov. Ten mení len to, čo počujete vy.

**Automatické stišovanie (`D`)** automaticky zníži úroveň hlasitosti hudby, kým niekto hovorí, a zdvihne ju, keď sa odmlčí. Je predvolene zapnuté a je platné pre celú miestnosť, takže jeho deaktivovanie túto funkcionalitu vypne pre všetkých. V oboch prípadoch budete na túto skutočnosť upozornení.

**Nastavenia zvuku** (ozubené koliesko na paneli nástrojov) obsahujúce:

- **Mikrofón** a **Reproduktory** — rozbaľovacie zoznamy zariadení. Zmeny sa použijú okamžite, aj uprostred hovoru, a ostanú zapamätané pre ďalšie používanie. Názvy zariadení sa zobrazia až po udelení povolenia pristupovať k mikrofónu.
- **Spracovanie hlasu** — potlačenie ozveny, potlačenie šumu a automatické vyrovnávanie úrovne. Predvolene zapnuté. Vypnite ho, ak vysielate hudbu alebo hráte na nástroj, pretože by vám prekážalo.
- **Vysoká kvalita hlasu (stereo)** — vysiela stereo s vyšším dátovým tokom. Predvolene vypnuté, pretože väčšina mikrofónov je mono a stojí to ostatných šírku pásma. Použije sa pri vašom **ďalšom** hovore, nie pri tom, v ktorom práve ste.
- **Ďalšie mikrofóny na streamovanie** — zoznam políčok, jedno za každé vstupné zariadenie, ktoré vlastníte okrem hlavného mikrofónu, každé s dvojicou prepínačov **Mono** / **Stereo**. Po zaškrtnutí sa zariadenie vysiela do miestnosti ako samostatný prúd popri vašom hlase a zobrazí sa ako samostatná položka v zozname používateľov všetkých. Takto ľudia posielajú mixážny pult, nástroj alebo virtuálny audio kábel. Stlmenie vášho mikrofónu tieto streamy nestlmí; na ich zastavenie zrušte zaškrtnutie.

---

# Zdieľanie zvuku do miestnosti

## Zvuk obrazovky alebo karty (`A`)

Stlačte `A` a prehliadač otvorí vlastný výber — systémový dialóg, nie súčasť SonicRoom, takže ho čítač obrazovky vníma ako samostatné okno. Vyberte obrazovku, okno alebo kartu **a zaškrtnite políčko, ktoré zdieľa jej zvuk**; bez neho je zdieľanie nemé. Najlepšie to funguje v Chrome a Edge; podpora zdieľania systémového zvuku vo Firefoxe je obmedzená alebo úplne chýba, podľa platformy.

Zdieľaný zvuk obchádza spracovanie a limiter vášho mikrofónu, takže hudba si zachová dynamiku. Vo zvukovom hovore sa obraz zahodí a odošle sa len zvuk. Opätovné stlačenie znaku `A` zdieľanie zastaví.

## Prehrávanie súboru, odkazu alebo súboru na serveri (`F`)

`F` otvorí dialóg **Prehrávať zvuk**, ktorý ponúka tri zdroje:

- **Vybrať z počítača** — výber súboru.
- **URL adresa zvuku** — textové pole. Vložte ľubovoľný verejný odkaz: priamy odkaz na súbor MP3, stream internetového rádia alebo stránku s videom či hudobného webu, z ktorej server zvuk extrahuje za vás.
- **Súbory na serveri** — prehliadateľný strom priečinkov so zvukmi uloženým na serveri. Prechádzajte šípkami, `Enter` na priečinku vstúpi dovnútra, `Enter` na súbore ho prehrá, `Backspace` vás vráti o priečinok vyššie. Dlhé názvy sú vizuálne skrátené, ale čítače obrazovky ich vyslovujú celé.

Keď sa niečo začne prehrávať, zobrazí sa malé okno **Prehrávanie súboru** a fokus pristane na jeho tlačidle prehrať/pozastaviť, takže `Medzerník` okamžite pozastaví. Má aj posuvník **Vaša hlasitosť**, ktorý mení len vaše vlastné odpočúvanie — miestnosť počuje súbor vždy v plnej úrovni — a tlačidlo zastavenia. `Escape` kdekoľvek v tomto okne zastaví prehrávanie a toto malé okno zatvorí.

Opätovné stlačenie `F` počas prehrávania znova otvorí výber a umožní vám prepnúť na iný zdroj bez reštartu prehrávania.

---

# Nahrávanie a živé vysielanie

**Nahrávanie (`R`)** prebieha na serveri, takže zachytí všetkých v plnej kvalite bez ohľadu na to, čo robí váš vlastný počítač. Spustenie a zastavenie sa oznámi celej miestnosti a v hlavičke sa zobrazí značka **REC** — nikoho hlas sa nenahráva bez toho, aby o tom vedel.

Keď nahrávka existuje, na paneli nástrojov sa objavia ďalšie dve tlačidlá:

- **Stiahnuť nahrávku** — celý rozhovor zmiešaný do jedného súboru. Môžete ho stlačiť, aj keď nahrávanie ešte beží; stiahne všetko doteraz zaznamenané a nahrávanie pokračuje ďalej.
- **Stiahnuť samostatné stopy** — zip archív s jedným súborom na používateľa, každý doplnený a časovo zarovnaný, aby po vložení do audio editora lícovali.

Vo videohovore je stiahnutie celého hovoru videosúbor s kamerami a obrazovkami všetkých v mriežke; vo zvukovom hovore je to zvukový súbor, ako vždy.

**Živé vysielanie** (rádiové tlačidlo na paneli nástrojov) posiela celý zmiešaný hovor na server Icecast, ktorý určíte. Panel žiada vyplniť názov hostiteľa, port, mountpoint, používateľa, heslo, formát a dátový tok a pamätá si ich v tomto prehliadači. Tieto údaje sa zvyšku miestnosti nikdy nezobrazia; miestnosť dostane len značku **LIVE** a upozornenie o tom, že vysielanie sa začalo, a kto ho spustil.

---

# Videohovory

Miestnosť je videohovor, len ak bola ako videohovor vytvorená — prepínač **Videohovor** na recepcii, ktorý sa potom nedá zmeniť späť. Vo zvukovom hovore nič z tohto neexistuje: žiadna kamera, žiadne `V`, žiadne `E` a zdieľanie obrazovky stále posiela len jej zvuk.

**Každý vstupuje s vypnutou kamerou**, vždy. Nič nezapne vašu kameru okrem vás.

- **`V`** zapína a vypína vašu kameru. Všetci sa to dozvedia s upozornenia aj v histórii textovej diskusie.
- **`E`** roztiahne oblasť videa na celú obrazovku; opätovné `E` alebo `Escape` ju opustí. Oznamuje sa oboje. V Safari na iOS, ktoré nemá celú obrazovku pre prvky stránky, to SonicRoom povie namiesto toho, aby neurobil nič.
- **Pripnutie** spôsobí, že jedna kamera alebo obrazovka vyplní oblasť videa len pre vás. Nachádza sa v možnostiach každého používateľa („Pripnúť video používateľa _meno_“), sa nikdy nikomu nesignalizuje a pripnutý používateľ o tom nie je informovaný. Ak si používateľ vypne kameru, pripnutie sa zachová a čaká — dozviete sa, že čaká, a tiež sa dozviete, keď sa obraz vráti späť.

**Sprievodca centrovaním tváre** je tlačidlo vedľa tlačidla kamery, predvolene zapnuté. Kým je kamera zapnutá, SonicRoom sleduje váš vlastný obraz a vyslovuje krátke korekcie — „posuňte sa doprava“, „posuňte sa nahor“, „ste vycentrovaný“, „vaša tvár nie je v zábere viditeľná“ — v asertívnej oblasti (live region), takže upozornenia sa prerušujú, a nečakajú v rade jedno za druhým. Smery sú udávané z vášho pohľadu, nie z pohľadu obrazu. Nápovedu systém opakuje každé tri sekundy, kým je ešte aktuálna, upozornenie o úspešnom „vycentrovaný“ oznámi len raz, keď sa vám podarí.

**„Opísať video osoby _meno_“** je v možnostiach každého používateľa, vrátane vás. Zachytí jeden záber a požiada Claude, aby ho v niekoľkých vetách opísal, prečítal akýkoľvek viditeľný text a použil nastavený jazyk aplikácie. Opis sa zapíše do histórie textovej diskusie ako všetko ostatné, takže `Alt` + `1` ho prečíta znova.

Vyžaduje to **váš vlastný API kľúč Claude**, ktorý zadáte tlačidlom kľúča na paneli nástrojov videa. Ukladá sa len v tomto prehliadači a požiadavka ide z vášho prehliadača priamo na Claude — nikdy neprechádza cez server SonicRoom.

**Pozadie videa** sa vyberá na **recepcii**, pod prepínačom _Videohovor_, a nikdy nie v hovore — vďaka tomu je obraz nastavený skôr, než sa čokoľvek odošle. Na výber je žiadne pozadie, rozostrenie, jeden zo šiestich dodaných obrázkov alebo váš vlastný obrázok. Všetko sa deje vo vašom prehliadači, takže miestnosť dostane vždy len hotový obraz a nikdy vaše skutočné okolie. Ak to váš prehliadač nedokáže, SonicRoom na to upozorní a pošle kameru bez pridávania pozadia, namiesto toho, aby potichu zlyhal.

---

# Verejné miestnosti, vstupovanie a hlasovanie

**V bežnej miestnosti SonicRoom nie sú žiadni moderátori ani správca.** Nikto nemôže nikoho odstrániť sám. Na oplátku majú verejné miestnosti dve kolektívne pravidlá. (**Moderované miestnosti**, ktoré majú aj správcov, sú samostatná vec: pozri nasledujúcu kapitolu.)

**Žiadosť vstúpiť.** Keď je miestnosť verejná a niekto nový žiada o vstup, všetci, ktorí sú už vnútri, začujú zvuk klopania a zobrazí sa im dialóg s menom používateľa a tlačidlami **Povoliť** a **Zamietnuť** (a **Povoliť všetkých** / **Zamietnuť všetkých**, keď čaká viac ľudí). Fokus ide rovno na prvé tlačidlo Povoliť a `Tab` cykicky prechádza po ovládacích prvkoch vo vnútri dialógového okna. Nedá sa zrušiť klávesom `Escape` — je to jediný dialóg, na ktorý musíte odpovedať. Odpovedať môže ktokoľvek; počíta sa prvá odpoveď. Zamietnutie niekoho ho zároveň zablokuje v tejto miestnosti.

Medzitým používateľ, ktorý žiada o vstup, počuje „Čakanie na povolenie vstúpiť do miestnosti…“ (Čaká sa, kým vás niekto v miestnosti pustí dnu…) a má k dispozícii len tlačidlo Zrušiť.

**Hlasovanie o odstránení.** Len vo verejných miestnostiach a len keď sú prítomní **traja alebo viacerí používatelia**. Pod tri sa možnosť vôbec neponúka, takže ju nemôže použiť jedna osoba proti druhej. Prah je _aspoň polovica_, vrátane dotknutej osoby: 2 hlasy z 3, 2 zo 4, 3 z 5.

Hlasovanie je v zozname možností každého používateľa. Jej názov nesie priebežný stav — „Odstrániť používateľa Ana (2 hlasy)“ — a každý hlas a každé zobranie hlasu späť sa oznámi celej miestnosti, aj s menami. Opätovným výberom svoj hlas zoberiete späť. Keďže prah závisí od počtu prítomných ľudí, môže existujúce hlasovanie cez hranicu pretlačiť aj odchod niekoho z miestnosti.

---

# Moderované miestnosti (so správcami)

Okrem súkromných a verejných miestností, ktoré moderátorov nemajú, môžete vytvoriť **moderovanú miestnosť**: miestnosť so **správcami**, určenú pre talk show a vedené panelové diskusie, kde musí byť niekto schopný umlčať osobu, ktorá zabudla stlmiť mikrofón, alebo okamžite odstrániť nežiadúceho používateľa. Všetko nižšie existuje len v tomto type miestnosti; bežná miestnosť zostáva nezmenená.

**Vytvorenie.** Na recepcii zaškrtnite **„Možnosti správcu“**. Rozbalí sa skupina **„Oprávnenia používateľov“** s políčkom („Povoliť viacerých správcov“) a jedným rozbaľovacím zoznamom pre každú akciu: nahrávanie, zdieľanie zvuku, prehrávanie zvuku, zapnutie či vypnutie automatického stišovania, živé vysielanie, schvaľovanie nových používateľov, používanie textovej diskusie, otváranie spoločných poznámok, stlmenie používateľa pre všetkých, stlmenie mikrofónov všetkých a odstraňovanie používateľov. Pri každej vyberiete **Len správcovia**, **Všetci** alebo **Nikto** (odstraňovanie ponúka aj **hlasovaním**). Posledné políčko skryje odkaz „Poháňa SonicRoom“ v miestnosti. Tieto voľby sa určia pri vytvorení miestnosti a počas jej existencie sa nikdy nemenia; prehliadač si pamätá vašu poslednú konfiguráciu pre nabudúce.

**Kto je správca?** Ten, kto miestnosť vytvorí. Ak ste povolili viacerých správcov, možnosti každého používateľa obsahujú **„Povýšiť na správcu“** (a **„Odvolať správcu“** na vrátenie). Správcovia majú v názve položky v zozname slovo „správca“. Ak stránku znova načítate alebo stratíte pripojenie, rolu dostanete späť, keď sa vrátite.

**Ak odídu všetci správcovia**, a používatelia zostanú pripojení, miestnosť **prestane byť moderovaná**: oznámi sa to všetkým („The last administrator has left: this room is no longer moderated“ — Posledný správca opustil miestnosť: Miestnosť viac nie je moderovaná. Všetci môžu opäť používať všetky funkcie.), všetky funkcie sa sprístupnia všetkým, textová diskusia sa znova otvorí a miestnosť pokračuje ako bežná súkromná alebo verejná miestnosť po zvyšok svojej existencie. Nikto nie je povýšený na miesto odchádzajúcich a bývalý správca, ak sa aj vráti späť, je bežným používateľom. Ak chcete, aby miestnosť prežila vašu neprítomnosť s nedotknutými pravidlami, určte pred odchodom druhého správcu.

**Vstup.** V moderovanej miestnosti novopríchodzí **vždy** žiadajú o vstup, či je verejná, alebo súkromná. Nastavenie „Schvaľovať novích používateľov“ rozhoduje, kto bude počuť zvuk zaklopania a komu sa zobrazí dialógové okno Povoliť / Zamietnuť: len správcovia, alebo všetci. Správcovia vchádzajú bez klopania.

**Stlmenie niekoho pre všetkých.** V možnostiach používateľa: **„Stlmiť pre všetkých“**. Jeho mikrofón sa vypne pre celú miestnosť a dozvie sa, kto to urobil. Je to _mäkké_ stlmenie: osoba môže mikrofón znova zapnúť klávesom `M`, keď má v úmysle hovoriť (čo vyrieši klasické „počujeme, ako hovoríte so susedom“ bez zdvíhania ruky). V ovládacom paneli vidí ten, kto na to má oprávnenie, aj **„Stlmiť mikrofóny všetkých“**, čo urobí to isté so všetkými ostatnými naraz. Jeho skratkou je `Ctrl` + `Shift` + `M` — zámerne trojklávesová kombinácia, aby sa nedala stlačiť omylom vedľa `M`. Existuje len v moderovanej miestnosti; inde si túto kombináciu ponecháva prehliadač.

**Odstraňovanie ľudí.** Podľa nastavenia: administrátori (alebo všetci) odstraňujú priamo z možností používateľa cez **„Odstrániť z miestnosti“**, bez hlasovania; alebo miestnosť hlasuje ako verejná miestnosť (s **aspoň tromi** oprávnenými hlasujúcimi; ak hlasujú len správcovia, počítajú sa len ich hlasy). Nikto nemôže odstrániť sám seba. Správcu môže stlmiť alebo odstrániť len iný správca.

**Na čo nemáte oprávnenia, sa nezobrazuje.** Ak vaša rola nepovoľuje nahrávanie, zdieľanie alebo prehrávanie zvuku, zmenu automatického stlmenia, živé vysielanie alebo písanie do textovej diskusie, príslušné tlačidlo na paneli nie je a zodpovedajúce písmeno (`R`, `A`, `F`, `D`) upozorní „You can't do that in this room“ (Nemôžete to vykonať v tejto miestnosti). Panel textovej diskusie sa stále otvorí, aj keď nemôžete písať správy, pretože v histórii sa hromadia všetky upozornenia.

Miestnosť nesie v hlavičke značku **MOD** a pri vstupe budete upozornení ako moderovaná spolu s tým, kto sú správcovia. Každá zmena (určenie, stlmenia, odstránenia) bude oznámená a zapíše do histórie textovej diskusie.

## Rezervované miestnosti (miestnosť pridelená vopred)

Miestnosť bežne existuje, len kým v nej niekto je, a vytvorí ju ten, kto príde prvý. To je problém, keď odkaz vopred propagujete: ktokoľvek by mohol otvoriť „vašu“ miestnosť pred vami a stať sa jej správcom, alebo by moderovaná miestnosť mohla jednoducho zaniknúť, len čo sa vyprázdni. **Rezervovaná miestnosť** to rieši. Prevádzkovateľ inštancie vám rezervuje názov miestnosti a dá vám **dva odkazy**:

- **odkaz správcu**, ktorý obsahuje tajný kľúč. Nechajte si ho pre seba; kto miestnosť otvorí s ním, je jej **správcom**, vždy, aj po odchode a opätovnom návrate;
- **verejný odkaz**, bežná adresa miestnosti, ktorú propagujete.

Kým miestnosť neotvoríte odkazom správcu, každý, kto nasleduje verejný odkaz, počuje „This room is reserved and its host hasn't opened it yet“ (Táto miestnosť je rezervovaná a jej správca ju ešte neotvoril) a čaká na tejto obrazovke; hneď ako vstúpite cez odkaz správcu, systém automaticky umožní čakajúcemu vstúpiť (a ďalší už potom žiadajú ako ktokoľvek, kto vstupuje do moderovanej miestnosti, takže rozhodujete vy, kto vojde). Rezervovaná miestnosť je vždy moderovaná miestnosť s oprávneniami pre používateľov, ktoré nastavil prevádzkovateľ pri rezervácii, a **zostáva moderovaná**, kým ste preč: nikto ju nemôže prevziať a vy sa vrátite ako jej správca.

Kľúč si váš prehliadač pamätá pre danú kartu, takže môžete stránku znova načítať alebo byť presmerovaný na recepciu kvôli zadaniu mena bez jeho straty, a z adresného riadka sa okamžite odstráni, aby skopírovaný odkaz nikdy kľúč nenosil. Ak odkaz hostiteľa stratíte, požiadajte prevádzkovateľa o nový (starý prestane fungovať).

---

# Spoločné poznámky

Ak má táto inštancia SonicRoom nastavené poznámky, panel nástrojov má tlačidlo **Spoločné poznámky** a `Alt` + `N` robí to isté. Otvorí jeden spoločný, kolaboračný poznámkový blok miestnosti **na novej karte prehliadača** — nikdy nie vo vnútri hovoru, takže váš čítač obrazovky pracuje s bežným upravovateľným dokumentom.

Prvé stlačenie poznámku vytvorí; stlačenie ktoréhokoľvek ďalšieho používateľa otvorí tú istú a skutočnosť, že existuje, sa oznámi a zapíše do textovej diskusie spolu s odkazom. Vráťte sa na kartu SonicRoom a hovor stále beží.

---

# Voľby, ktoré môžete zadať do panelu s adresou

Čokoľvek za znakom `?` v odkaze na miestnosť nastavuje voľbu a viaceré možno kombinovať pomocou `&`.

| Voľba              | Účinok                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `?displayName=Ana` | Pripojí sa s týmto menom, preskočí čakáreň                                                          |
| `?video=on`        | Urobí z miestnosti videohovor                                                                       |
| `?public=true`     | Urobí miestnosť verejnou                                                                            |
| `?mic=off`         | Pripojí sa bez mikrofónu — len počúvanie a textová diskusia                                                      |
| `?p2p=off`         | Vždy sprostredkuje cez server, aj pre dvoch používateľov                                                  |
| `?lang=es`         | Vynúti jazyk rozhrania (`en`, `es`, `fr`, `sk`)                                                           |
| `?ios=on`          | Vynúti zvukovú cestu iOS v ľubovoľnom prehliadači (náhradné riešenie tvrdohlavých problémov so zvukom) |
| `?host=…`          | Otvorí rezervovanú miestnosť ako jej správca (pozri „Rezervované miestnosti“); okamžite sa odstráni z adresného riadka |

Napríklad odkaz, ktorý niekoho rovno pripojí do francúzskeho videohovoru ako „Ana“:

```
https://your-instance.example/room/studio?video=on&lang=fr&displayName=Ana
```

---

# Keď niečo nefunguje

**Jedno písmeno nič nenapíše a nič nerobí.**
Váš čítač obrazovky je v režime čítania a jednoznakový klávesový príkaz pohltí. `NVDA` + `Medzerník`, `Kláves JAWS` + `Z`, `Caps Lock` + `Medzerník` pre Narrator, alebo vypnite Quick Nav vo VoiceOveri. Zďaleka najčastejší problém.

**Jedno písmeno sa objaví vo vstupnom poli textovej diskusie.**
Fokus je v poli správy. Je to zámer — musíte byť schopní napísať do správy písmeno M. Stlačte `Escape` na zatvorenie panela textovej diskusie alebo z poľa odídite klávesom `Tab`, a skúste znova. `Alt` + číslo je jediná skratka, ktorá funguje aj zvnútra poľa.

**`Tab` ma nepresunie na ďalšie tlačidlo na paneli nástrojov.**
Tak to nemá byť. Celý panel nástrojov je jediné zastavenie klávesu; použite `šípku doprava`. `Tab` panel nástrojov opúšťa.

**`Alt` + číslo oznámi „Žiadna správa 1“.**
V miestnosti sa ešte nič nezaznamenalo do histórie. Udalosti v miestnosti sa počítajú ako správy, takže históriu začne napĺňať prvý vstupujúci používateľ.

**Nikoho nepočujem.**
Skontrolujte rozbaľovací zoznam **Reproduktory** v nastaveniach zvuku — prehliadače nie vždy nasledujú predvolené systémové zariadenie. Potom skontrolujte, či ste daného používateľa sami nestlmili: jej riadok by sa čítal „stlmený vami“.

**Ostatní hovoria, že zniem veľmi potichu.**
Zvýšte **Úroveň vášho mikrofónu** v možnostiach používateľa pre samého seba cez zoznam používateľov alebo použite tlačidlo Test na recepcii, ktoré pri nastavovaní oznamuje úroveň hlasitosti.

**Môj ďalší mikrofón sa nespustil.**
SonicRoom žiada presne dané zariadenie a neprijíma náhradu, takže ak ho používa iný program alebo je odpojené, zlyhá namiesto toho, aby potichu poslalo váš hlavný mikrofón dvakrát. Zatvorte aplikáciu, ktorá zariadenie používa, a zaškrtnite ho znova.

**Zdieľanie obrazovky nezdieľa zvuk.**
Políčko zvuku v samotnom dialógu zdieľania prehliadača nebolo zaškrtnuté. Ten dialóg patrí prehliadaču, nie SonicRoom. Skúste Chrome alebo Edge, ak váš prehliadač túto možnosť vôbec neponúka.

**„Opísať video“ hovorí, aby ste pridali kľúč API.**
Táto funkcia používa váš vlastný API kľúč Claude, zadaný tlačidlom kľúča na paneli nástrojov videa. Uchováva sa len v tomto prehliadači.

---

# Jednostranový prehľad klávesov

| Kláves                                  | Akcia                                         |
| --------------------------------------- | --------------------------------------------- |
| `M`                                     | Stlmiť / zrušiť stlmenie                      |
| `A`                                     | Zdieľať / prestať zdieľať zvuk obrazovky alebo karty |
| `F`                                     | Prehrávať zvuk — otvoriť výber zdroja        |
| `D`                                     | Automatické stišovanie zap. / vyp. (celá miestnosť) |
| `R`                                     | Spustiť / zastaviť nahrávanie                 |
| `W`                                     | Kto hovorí                                    |
| `V`                                     | Kamera zap. / vyp. (videohovory)              |
| `E`                                     | Video na celú obrazovku (videohovory)         |
| `Alt` + `1`…`9`, `0`                    | Prečítať posledných desať správ, najnovšia je prvá |
| Rovnaké `Alt` + číslo dvakrát           | Skopírovať danú správu                        |
| `Alt` + `N`                             | Spoločné poznámky na novej karte               |
| `Ctrl` + `Shift` + `M`                  | Stlmiť všetkých (moderované miestnosti)       |
| `Tab` / `Shift` + `Tab`                 | Navigácia po častiach aplikácie                       |
| `Doľava` / `Doprava`                    | Navigácia na paneli nástrojov; zmena posuvníka          |
| `Nahor` / `Nadol`                       | Pohyb v zozname                                    |
| `Home` / `End`                          | Prvá / posledná položka; minimálna / maximálna hodnota posuvníka           |
| `Enter` / `Medzerník`                   | Aktivovať                                     |
| `Escape`                                | Zatvoriť panel, dialóg alebo celú obrazovku   |
| `Backspace`                             | Späť z možností; o priečinok vyššie           |
| `Enter` v poli správy                   | Odoslať                                       |
| `Shift` + `Enter` v poli správy         | Nový riadok                                   |
| `Ctrl` / `Cmd` + `C` na správe          | Skopírovať ju                                 |
| `NVDA` + `Medzerník`                    | NVDA: režim prehliadania ↔ režim fokusu    |
| `Kláves JAWS` + `Z`                        | JAWS: virtuálny kurzor vyp. / zap.            |
| `Caps Lock` + `Medzerník`               | Narrator: režim skenovania vyp. / zap.        |
| `Doľava` + `Doprava` súčasne            | VoiceOver: Quick Nav vyp. / zap.              |
| `Orca Modifier` + `A`                   | Orca: režim prehliadania ↔ režim zameriavania    |
