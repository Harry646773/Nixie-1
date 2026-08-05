'use strict'

const SAMPLE_TEXT = 'NIXIE PREMIUM'
const DEFAULT_FONT = 'regular'
const DEFAULT_REPLY_STYLE = 'default'

const alphaUpper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const alphaLower = 'abcdefghijklmnopqrstuvwxyz'
const digits = '0123456789'

function buildMap(upperStart, lowerStart, digitStart) {
    const map = {}
    if (upperStart !== null) {
        for (let i = 0; i < alphaUpper.length; i++) {
            map[alphaUpper[i]] = String.fromCodePoint(upperStart + i)
        }
    }
    if (lowerStart !== null) {
        for (let i = 0; i < alphaLower.length; i++) {
            map[alphaLower[i]] = String.fromCodePoint(lowerStart + i)
        }
    }
    if (digitStart !== null) {
        for (let i = 0; i < digits.length; i++) {
            map[digits[i]] = String.fromCodePoint(digitStart + i)
        }
    }
    return map
}

function buildMapFromStrings(keys, values) {
    const map = {}
    for (let i = 0; i < keys.length && i < values.length; i++) {
        map[keys[i]] = values[i]
    }
    return map
}

const FONT_MAPS = {
    regular: null,
    bold: buildMap(0x1D400, 0x1D41A, 0x1D7CE),
    italic: buildMap(0x1D434, 0x1D44E, null),
    bolditalic: buildMap(0x1D468, 0x1D482, null),
    monospace: buildMap(0x1D670, 0x1D68A, 0x1D7F6),
    sans: buildMap(0x1D5A0, 0x1D5BA, 0x1D7E2),
    sansbold: buildMap(0x1D5D4, 0x1D5EE, 0x1D7EC),
    sansitalic: buildMap(0x1D608, 0x1D622, null),
    sansbolditalic: buildMap(0x1D63C, 0x1D656, null),
    fullwidth: buildMap(0xFF21, 0xFF41, 0xFF10),
    circled: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
        [
            'Ⓐ','Ⓑ','Ⓒ','Ⓓ','Ⓔ','Ⓕ','Ⓖ','Ⓗ','Ⓘ','Ⓙ','Ⓚ','Ⓛ','Ⓜ','Ⓝ','Ⓞ','Ⓟ','Ⓠ','Ⓡ','Ⓢ','Ⓣ','Ⓤ','Ⓥ','Ⓦ','Ⓧ','Ⓨ','Ⓩ',
            'ⓐ','ⓑ','ⓒ','ⓓ','ⓔ','ⓕ','ⓖ','ⓗ','ⓘ','ⓙ','ⓚ','ⓛ','ⓜ','ⓝ','ⓞ','ⓟ','ⓠ','ⓡ','ⓢ','ⓣ','ⓤ','ⓥ','ⓦ','ⓧ','ⓨ','ⓩ',
            '⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨'
        ]
    ),
    squared: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
        [
            '🄰','🄱','🄲','🄳','🄴','🄵','🄶','🄷','🄸','🄹','🄺','🄻','🄼','🄽','🄾','🄿','🅀','🅁','🅂','🅃','🅄','🅅','🅆','🅇','🅈','🅉',
            '🄰','🄱','🄲','🄳','🄴','🄵','🄶','🄷','🄸','🄹','🄺','🄻','🄼','🄽','🄾','🄿','🅀','🅁','🅂','🅃','🅄','🅅','🅆','🅇','🅈','🅉',
            '0','1','2','3','4','5','6','7','8','9'
        ]
    ),
    smallcaps: buildMapFromStrings(
        'abcdefghijklmnopqrstuvwxyz'.split(''),
        [
            'ᴀ','ʙ','ᴄ','ᴅ','ᴇ','ꜰ','ɢ','ʜ','ɪ','ᴊ','ᴋ','ʟ','ᴍ','ɴ','ᴏ','ᴘ','ǫ','ʀ','s','ᴛ','ᴜ','ᴠ','ᴡ','x','ʏ','ᴢ'
        ]
    ),
    script: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            '𝒜','ℬ','𝒞','𝒟','ℰ','ℱ','𝒢','ℋ','ℐ','𝒥','𝒦','ℒ','ℳ','𝒩','𝒪','𝒫','𝒬','ℛ','𝒮','𝒯','𝒰','𝒱','𝒲','𝒳','𝒴','𝒵',
            '𝒶','𝒷','𝒸','𝒹','ℯ','𝒻','ℊ','𝒽','𝒾','𝒿','𝓀','𝓁','𝓂','𝓃','ℴ','𝓅','𝓆','𝓇','𝓈','𝓉','𝓊','𝓋','𝓌','𝓍','𝓎','𝓏'
        ]
    ),
    fraktur: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            '𝔄','𝔅','ℭ','𝔇','𝔈','𝔉','𝔊','ℌ','ℑ','𝔍','𝔎','𝔏','𝔐','𝔑','𝔒','𝔓','𝔔','ℜ','𝔖','𝔗','𝔘','𝔙','𝔚','𝔛','𝔜','ℨ',
            '𝔞','𝔟','𝔠','𝔡','𝔢','𝔣','𝔤','𝔥','𝔦','𝔧','𝔨','𝔩','𝔪','𝔫','𝔬','𝔭','𝔮','𝔯','𝔰','𝔱','𝔲','𝔳','𝔴','𝔵','𝔶','𝔷'
        ]
    ),
    doublestuck: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
        [
            '𝔸','𝔹','ℂ','𝔻','𝔼','𝔽','𝔾','ℍ','𝕀','𝕁','𝕂','𝕃','𝕄','ℕ','𝕆','ℙ','ℚ','ℝ','𝕊','𝕋','𝕌','𝕍','𝕎','𝕏','𝕐','ℤ',
            '𝕒','𝕓','𝕔','𝕕','𝕖','𝕗','𝕘','𝕙','𝕚','𝕛','𝕜','𝕝','𝕞','𝕟','𝕠','𝕡','𝕢','𝕣','𝕤','𝕥','𝕦','𝕧','𝕨','𝕩','𝕪','𝕫',
            '0','1','2','3','4','5','6','7','8','9'
        ]
    ),
    parenthesized: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
        [
            '(A)','(B)','(C)','(D)','(E)','(F)','(G)','(H)','(I)','(J)','(K)','(L)','(M)','(N)','(O)','(P)','(Q)','(R)','(S)','(T)','(U)','(V)','(W)','(X)','(Y)','(Z)',
            '(a)','(b)','(c)','(d)','(e)','(f)','(g)','(h)','(i)','(j)','(k)','(l)','(m)','(n)','(o)','(p)','(q)','(r)','(s)','(t)','(u)','(v)','(w)','(x)','(y)','(z)',
            '(0)','(1)','(2)','(3)','(4)','(5)','(6)','(7)','(8)','(9)'
        ]
    ),
    wide: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            'Ａ','Ｂ','Ｃ','Ｄ','Ｅ','Ｆ','Ｇ','Ｈ','Ｉ','Ｊ','Ｋ','Ｌ','Ｍ','Ｎ','Ｏ','Ｐ','Ｑ','Ｒ','Ｓ','Ｔ','Ｕ','Ｖ','Ｗ','Ｘ','Ｙ','Ｚ',
            'ａ','ｂ','ｃ','ｄ','ｅ','ｆ','ｇ','ｈ','ｉ','ｊ','ｋ','ｌ','ｍ','ｎ','ｏ','ｐ','ｑ','ｒ','ｓ','ｔ','ｕ','ｖ','ｗ','ｘ','ｙ','ｚ'
        ]
    ),
    bubble: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            'Ⓐ','Ⓑ','Ⓒ','Ⓓ','Ⓔ','Ⓕ','Ⓖ','Ⓗ','Ⓘ','Ⓙ','Ⓚ','Ⓛ','Ⓜ','Ⓝ','Ⓞ','Ⓟ','Ⓠ','Ⓡ','Ⓢ','Ⓣ','Ⓤ','Ⓥ','Ⓦ','Ⓧ','Ⓨ','Ⓩ',
            'ⓐ','ⓑ','ⓒ','ⓓ','ⓔ','ⓕ','ⓖ','ⓗ','ⓘ','ⓙ','ⓚ','ⓛ','ⓜ','ⓝ','ⓞ','ⓟ','ⓠ','ⓡ','ⓢ','ⓣ','ⓤ','ⓥ','ⓦ','ⓧ','ⓨ','ⓩ'
        ]
    ),
    gothic: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            '𝔸','𝔹','𝔻','𝔼','𝔽','𝔾','𝕀','𝕁','𝕂','𝕃','𝕄','ℕ','𝕆','ℙ','ℚ','ℝ','𝕊','𝕋','𝕌','𝕍','𝕎','𝕏','𝕐','ℤ','𝔞','𝔟','𝔡','𝔢','𝔣','𝔤','𝔥','𝔦','𝔧','𝔨','𝔩','𝔪','𝔫','𝔬','𝔭','𝔮','𝔯','𝔰','𝔱','𝔲','𝔳','𝔴','𝔵','𝔶','𝔷'
        ]
    ),
    fancy: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            '𝓐','𝓑','𝓒','𝓓','𝓔','𝓕','𝓖','𝓗','𝓘','𝓙','𝓚','𝓛','𝓜','𝓝','𝓞','𝓟','𝓠','𝓡','𝓢','𝓣','𝓤','𝓥','𝓦','𝓧','𝓨','𝓩',
            '𝓪','𝓫','𝓬','𝓭','𝓮','𝓯','𝓰','𝓱','𝓲','𝓳','𝓴','𝓵','𝓶','𝓷','𝓸','𝓹','𝓺','𝓻','𝓼','𝓽','𝓾','𝓿','𝔀','𝔁','𝔂','𝔃'
        ]
    ),
    cursive: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            '𝒜','𝐵','𝒞','𝒟','𝐸','𝐹','𝒢','𝐻','𝐼','𝒥','𝒦','𝐿','𝑀','𝒩','𝒪','𝒫','𝒬','𝑅','𝒮','𝒯','𝒰','𝒱','𝒲','𝒳','𝒴','𝒵',
            '𝒶','𝒷','𝒸','𝒹','ℯ','𝒻','𝓰','𝒽','𝒾','𝒿','𝓀','𝓁','𝓂','𝓃','ℴ','𝓅','𝓆','𝓇','𝓈','𝓉','𝓊','𝓋','𝓌','𝓍','𝓎','𝓏'
        ]
    ),
    mirror: buildMapFromStrings(
        'ABCDabcdEFGHefghIJKLijklMNOPmnopQRSTqrstUVWXYZuvwxyz0123456789'.split(''),
        [
            '∀','𐐒','Ɔ','◖','Ǝ','Ⅎ','⅁','H','I','ſ','⋊','˥','W','N','O','Ԁ','Q','R','S','⊥','ꓤ','∩','Λ','X','Y','Z',
            'ɐ','q','ɔ','p','ǝ','ɟ','ƃ','ɥ','ı','ɾ','ʞ','ן','ɯ','u','o','d','b','ɹ','s','ʇ','n','ʌ','ʍ','x','ʎ','z',
            '0','1','2','3','4','5','6','7','8','9'
        ]
    ),
    greekish: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            'Α','Β','Ϲ','Δ','Ε','Ϝ','ɢ','Η','Ι','ϳ','Κ','Ḻ','Μ','Ν','Ο','Ρ','Ϙ','ϒ','Ѕ','Τ','∪','Ѵ','Ш','Χ','Υ','Ζ',
            'α','в','ς','∂','є','ƒ','ɡ','н','ι','ϳ','κ','ℓ','м','η','σ','ρ','ϙ','я','ѕ','т','υ','ν','ω','χ','у','z'
        ]
    ),
    dotted: buildMapFromStrings(
        'abcdefghijklmnopqrstuvwxyz'.split(''),
        [
            'ȧ','ḃ','ċ','ḋ','ė','ḟ','ġ','ḣ','İ','ĵ','ḱ','ŀ','ṁ','ṅ','ṍ','ṗ','ẅ','ṙ','ṡ','ṫ','ṳ','ṿ','ẇ','ẋ','ẏ','ż'
        ]
    ),
    stroked: buildMapFromStrings(
        'abcdefghijklmnopqrstuvwxyz'.split(''),
        [
            'ȧ','ƀ','ƈ','ḓ','ė','ƒ','ɠ','ḣ','ı','ĵ','ķ','ŀ','ṃ','ṅ','ǿ','ṗ','ɋ','ŗ','ş','ẗ','ũ','ṽ','ẅ','ẍ','ẏ','ž'
        ]
    ),
    sparkly: buildMapFromStrings(
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''),
        [
            '✨','🌟','🌈','💫','🌸','🔥','🌙','⭐','💎','🎉','🌊','🍀','🌺','🌻','🌟','💥','🌟','🌙','✨','⚡','🌠','🎆','🌟','💫','🔥','✨',
            '✨','🌟','🌈','💫','🌸','🔥','🌙','⭐','💎','🎉','🌊','🍀','🌺','🌻','🌟','💥','🌟','🌙','✨','⚡','🌠','🎆','🌟','💫','🔥','✨'
        ]
    ),
}

const FONT_ALIASES = {
    strong: 'bold',
    slanted: 'italic',
    code: 'monospace',
    minimal: 'sans',
    vip: 'fullwidth',
    premium: 'fullwidth',
    techno: 'squared',
    classic: 'script',
    ancient: 'fraktur',
    royal: 'circled',
    cosmic: 'wide',
    pixel: 'monospace',
    zap: 'fullwidth',
    neon: 'bubble',
    vaporwave: 'fullwidth',
    cyber: 'gothic',
    elite: 'bold',
    luxury: 'bolditalic',
    shadow: 'stroked',
    energy: 'dotted',
    aura: 'cursive',
    prism: 'wide',
    storm: 'greekish',
    titan: 'doublestuck',
    omega: 'doublestuck',
    luxury: 'bolditalic',
    royalty: 'circled',
    future: 'sansitalic',
    archaic: 'parenthesized',
    funky: 'bubble',
    vintage: 'fraktur',
    arcade: 'monospace',
    deluxe: 'bold',
    ornate: 'script',
    elite: 'bold',
    galaxy: 'wide',
    horizon: 'fullwidth',
    custom: 'regular',
}

const FONT_STYLES = Array.from(new Set(['regular', ...Object.keys(FONT_MAPS), ...Object.keys(FONT_ALIASES)])).filter(Boolean)

function resolveFontName(name) {
    if (!name) return DEFAULT_FONT
    const lower = String(name).toLowerCase()
    if (FONT_MAPS[lower]) return lower
    if (FONT_ALIASES[lower]) return FONT_ALIASES[lower]
    return DEFAULT_FONT
}

function applyFont(text, style = DEFAULT_FONT) {
    if (typeof text !== 'string') return text
    const fontKey = resolveFontName(style)
    const fontMap = FONT_MAPS[fontKey]
    if (!fontMap) return text
    return Array.from(text).map((ch) => {
        const mapped = fontMap[ch] || fontMap[ch.toLowerCase()]
        return mapped || ch
    }).join('')
}

function listFonts() {
    return FONT_STYLES.sort()
}

function fontExists(name) {
    if (!name) return false
    const lower = String(name).toLowerCase()
    return FONT_STYLES.includes(lower)
}

function previewFont(style) {
    return applyFont(SAMPLE_TEXT, style)
}

function buildFontListPreview() {
    return listFonts().map((name) => `${name}: ${previewFont(name)}`)
}

module.exports = {
    applyFont,
    fontExists,
    listFonts,
    previewFont,
    buildFontListPreview,
}
