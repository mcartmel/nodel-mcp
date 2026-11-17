/** Java Nodel.reduce + SimpleName.flatten (not v1's NFKC/alphanumeric rule).
 * Non-ASCII punctuation and identifier characters, including FEFF, survive.
 * Matching is advisory; Java/JS Unicode database versions may differ. */
import { reduceNodelName } from "../../../shared/nodelName.js";

const dialects: Array<[string, string]> = [
  ["äæǽ", "ae"],
  ["öœ", "oe"],
  ["ü", "ue"],
  ["Ä", "ae"],
  ["Ü", "ue"],
  ["Ö", "oe"],
  ["ÀÁÂÃÄÅǺĀĂĄǍΑΆẢẠẦẪẨẬẰẮẴẲẶАàáâãåǻāăąǎªαάảạầấẫẩậằắẵẳặа", "a"],
  ["Бб", "b"],
  ["ÇĆĈĊČçćĉċč", "c"],
  ["Дд", "d"],
  ["ÐĎĐΔðďđδ", "dj"],
  ["ÈÉÊËĒĔĖĘĚΕΈẼẺẸỀẾỄỂỆЕЭèéêëēĕėęěέεẽẻẹềếễểệеэ", "e"],
  ["Фф", "f"],
  ["ĜĞĠĢΓГҐĝğġģγгґ", "g"],
  ["ĤĦĥħ", "h"],
  ["ÌÍÎÏĨĪĬǏĮİΗΉΊΙΪỈỊИЫìíîïĩīĭǐįıηήίιϊỉịиыї", "i"],
  ["Ĵĵ", "j"],
  ["ĶΚКķκк", "k"],
  ["ĹĻĽĿŁΛЛĺļľŀłλл", "l"],
  ["Мм", "m"],
  ["ÑŃŅŇΝНñńņňŉνн", "n"],
  ["ÒÓÔÕŌŎǑŐƠØǾΟΌΩΏỎỌỒỐỖỔỘỜỚỠỞỢОòóôõōŏǒőơøǿºοόωώỏọồốỗổộờớỡởợо", "o"],
  ["Пп", "p"],
  ["ŔŖŘΡРŕŗřρр", "r"],
  ["ŚŜŞȘŠΣСśŝşșšſσςс", "s"],
  ["ȚŢŤŦτТțţťŧт", "t"],
  ["ÙÚÛŨŪŬŮŰŲƯǓǕǗǙǛŨỦỤỪỨỮỬỰУùúûũūŭůűųưǔǖǘǚǜυύϋủụừứữửựу", "u"],
  ["ÝŸŶΥΎΫỲỸỶỴЙýÿŷỳỹỷỵй", "y"],
  ["Вв", "v"],
  ["Ŵŵ", "w"],
  ["ŹŻŽΖЗźżžζз", "z"],
  ["ÆǼ", "ae"],
  ["ß", "ss"],
  ["Ĳĳ", "ij"],
  ["Œ", "oe"],
  ["ƒ", "f"],
  ["ξ", "ks"],
  ["π", "p"],
  ["β", "v"],
  ["μ", "m"],
  ["ψ", "ps"],
  ["Ёё", "yo"],
  ["Єє", "ye"],
  ["Ї", "yi"],
  ["Жж", "zh"],
  ["Хх", "kh"],
  ["Цц", "ts"],
  ["Чч", "ch"],
  ["Шш", "sh"],
  ["Щщ", "shch"],
  ["ЪъЬь", ""],
  ["Юю", "yu"],
  ["Яя", "ya"],
];
const dialectMap = new Map<string, string>();
for (const [characters, replacement] of dialects)
  for (const character of characters) dialectMap.set(character, replacement);

export function javaActionName(name: string) {
  let result = "";
  const reduced = reduceNodelName(name);
  // Deliberately UTF-16 code units, like Java char iteration.
  for (let index = 0; index < reduced.length; index++) {
    const ch = reduced[index]!;
    result += dialectMap.get(ch) ?? ch.toLowerCase();
  }
  return result;
}

/** Same edge whitespace as upstream utils/edge-whitespace, notably NOT FEFF. */
export const trimPointReference = (value: string) =>
  value.replace(/^[\t-\r \p{Zs}\p{Zl}\p{Zp}]+|[\t-\r \p{Zs}\p{Zl}\p{Zp}]+$/gu, "");
