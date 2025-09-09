export class CompanyNormalizer {
  constructor() {
    this.legalForms = [
      'INC', 'LTÉE', 'LTEE', 'CORP', 'CORPORATION', 'LTD', 'LIMITED',
      'S.E.N.C', 'SENC', 'S.E.C', 'SEC', 'S.E.N.C.R.L', 'SENCRL',
      'FIDUCIE', 'COOP', 'COOPÉRATIVE', 'COOPERATIVE'
    ];
    
    this.abbreviations = {
      'INVEST': 'INVESTISSEMENTS',
      'IMMOB': 'IMMOBILIER',
      'IMMEUB': 'IMMEUBLES',
      'DEV': 'DÉVELOPPEMENT',
      'CONST': 'CONSTRUCTION',
      'GESTION': 'GESTION',
      'PROP': 'PROPRIÉTÉS',
      'GRP': 'GROUPE',
      'CIE': 'COMPAGNIE',
      'ENT': 'ENTREPRISES'
    };
    
    this.accentMap = {
      'À': 'A', 'É': 'E', 'È': 'E', 'Ê': 'E', 'Ç': 'C',
      'à': 'a', 'é': 'e', 'è': 'e', 'ê': 'e', 'ç': 'c'
    };
  }

  normalize(name) {
    if (!name) return '';
    
    let normalized = name.toUpperCase();
    normalized = this.cleanBasic(normalized);
    
    if (normalized.includes('/')) {
      const parts = normalized.split('/');
      normalized = parts[0].trim();
    }
    
    normalized = this.normalizeLegalForms(normalized);
    normalized = normalized.replace(/\s*&\s*/g, ' ET ');
    normalized = this.normalizeQuebec(normalized);
    normalized = normalized.replace(/\s+/g, ' ').trim();
    
    return normalized;
  }

  generateVariations(name) {
    const variations = new Set();
    variations.add(name);
    
    if (name.includes('/')) {
      const parts = name.split('/').map(p => p.trim());
      parts.forEach(part => variations.add(part));
    }
    
    variations.add(this.removeAccents(name));
    
    if (name.includes('QUEBEC')) {
      variations.add(name.replace(/QUEBEC/g, 'QUÉBEC'));
    } else if (name.includes('QUÉBEC')) {
      variations.add(name.replace(/QUÉBEC/g, 'QUEBEC'));
    }
    
    if (name.includes('LTÉE')) {
      variations.add(name.replace(/LTÉE/g, 'LTEE'));
    } else if (name.includes('LTEE')) {
      variations.add(name.replace(/LTEE/g, 'LTÉE'));
    }
    
    const numberPattern = /(\d{4})-(\d{4})\s+(QUÉBEC|QUEBEC)/;
    const match = name.match(numberPattern);
    if (match) {
      variations.add(`${match[1]}-${match[2]} QUÉBEC INC`);
      variations.add(`${match[1]}-${match[2]} QUEBEC INC`);
    }
    
    return Array.from(variations);
  }

  cleanBasic(name) {
    return name
      .replace(/\s+/g, ' ')
      .replace(/['\']/g, "'")
      .trim();
  }

  normalizeLegalForms(name) {
    name = name.replace(/\bLTEE\b/g, 'LTÉE');
    name = name.replace(/\bINC\./g, 'INC');
    name = name.replace(/\bLTÉE\./g, 'LTÉE');
    name = name.replace(/\bLTD\./g, 'LTD');
    return name;
  }

  normalizeQuebec(name) {
    const numberPattern = /(\d{4})-(\d{4})\s+(QUEBEC|QUÉBEC)/;
    if (numberPattern.test(name)) {
      name = name.replace(/QUEBEC/g, 'QUÉBEC');
    }
    return name;
  }

  removeAccents(text) {
    return text.split('').map(char => this.accentMap[char] || char).join('');
  }

  isPublicBody(name) {
    const patterns = [
      /^VILLE\s+DE?\s+/i,
      /^MUNICIPALIT[EÉ]/i,
      /^OMH\s+/i,
      /^UNIVERSIT[EÉ]/i,
      /^C[EÉ]GEP/i
    ];
    
    return patterns.some(pattern => pattern.test(name));
  }
}