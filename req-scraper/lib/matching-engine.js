import leven from 'leven';

export class MatchingEngine {
  constructor(strictMode = false) {
    this.strictMode = strictMode;
    this.thresholds = {
      exact: 1.00,
      prefix: 0.95,
      fuzzy: strictMode ? 0.95 : 0.88
    };
  }

  match(searchName, candidateName, hintCity = null, candidateCity = null) {
    if (!searchName || !candidateName) {
      return { score: 0, method: 'none' };
    }
    
    const search = this.normalizeForMatching(searchName);
    const candidate = this.normalizeForMatching(candidateName);
    
    if (this.isExactMatch(search, candidate)) {
      return { score: 1.00, method: 'exact' };
    }
    
    const prefixScore = this.getPrefixScore(search, candidate);
    if (prefixScore >= this.thresholds.prefix) {
      return { score: prefixScore, method: 'prefix' };
    }
    
    if (this.strictMode) {
      return { score: prefixScore, method: 'none' };
    }
    
    const fuzzyScore = this.getFuzzyScore(search, candidate);
    
    let finalScore = fuzzyScore;
    if (hintCity && candidateCity) {
      const cityBonus = this.getCityBonus(hintCity, candidateCity);
      finalScore = Math.min(1.0, fuzzyScore + cityBonus);
    }
    
    if (finalScore >= this.thresholds.fuzzy) {
      return { score: finalScore, method: 'fuzzy' };
    }
    
    return { score: finalScore, method: 'none' };
  }

  normalizeForMatching(str) {
    return str
      .toUpperCase()
      .replace(/[^A-Z0-9ÀÂÄÈÉÊËÏÎÔÙÛÜŸÇŒÆ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  isExactMatch(search, candidate) {
    if (search === candidate) return true;
    
    const searchNoAccent = this.removeAccents(search);
    const candidateNoAccent = this.removeAccents(candidate);
    if (searchNoAccent === candidateNoAccent) return true;
    
    if (this.isNumberedCompany(search)) {
      return this.matchNumberedCompany(search, candidate);
    }
    
    return false;
  }

  getPrefixScore(search, candidate) {
    if (search.startsWith(candidate) || candidate.startsWith(search)) {
      const lengthRatio = Math.min(search.length, candidate.length) / 
                         Math.max(search.length, candidate.length);
      return 0.95 + (lengthRatio * 0.05);
    }
    
    const searchTokens = search.split(' ').filter(t => t.length > 0);
    const candidateTokens = candidate.split(' ').filter(t => t.length > 0);
    
    let matchedTokens = 0;
    let totalTokens = Math.max(searchTokens.length, candidateTokens.length);
    
    for (let i = 0; i < Math.min(searchTokens.length, candidateTokens.length); i++) {
      if (searchTokens[i] === candidateTokens[i]) {
        matchedTokens++;
      } else if (searchTokens[i].startsWith(candidateTokens[i]) || 
                 candidateTokens[i].startsWith(searchTokens[i])) {
        matchedTokens += 0.8;
      } else {
        break;
      }
    }
    
    return matchedTokens / totalTokens;
  }

  getFuzzyScore(search, candidate) {
    const searchNorm = this.removeAccents(search);
    const candidateNorm = this.removeAccents(candidate);
    
    const maxLen = Math.max(searchNorm.length, candidateNorm.length);
    const levenDist = leven(searchNorm, candidateNorm);
    const levenScore = 1 - (levenDist / maxLen);
    
    const jaccardScore = this.getJaccardSimilarity(searchNorm, candidateNorm);
    
    let finalScore = (levenScore * 0.5) + (jaccardScore * 0.5);
    
    return Math.min(1.0, finalScore);
  }

  getJaccardSimilarity(str1, str2) {
    const tokens1 = new Set(str1.split(' ').filter(t => t.length > 2));
    const tokens2 = new Set(str2.split(' ').filter(t => t.length > 2));
    
    if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
    if (tokens1.size === 0 || tokens2.size === 0) return 0.0;
    
    const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
    const union = new Set([...tokens1, ...tokens2]);
    
    return intersection.size / union.size;
  }

  getCityBonus(hintCity, candidateCity) {
    if (!hintCity || !candidateCity) return 0;
    
    const hint = this.normalizeForMatching(hintCity);
    const candidate = this.normalizeForMatching(candidateCity);
    
    if (hint === candidate) return 0.05;
    if (hint.startsWith(candidate) || candidate.startsWith(hint)) return 0.03;
    
    return 0;
  }

  isNumberedCompany(name) {
    return /\d{4}[\s-]\d{4}/.test(name);
  }

  matchNumberedCompany(search, candidate) {
    const searchMatch = search.match(/(\d{4})[\s-](\d{4})/);
    const candidateMatch = candidate.match(/(\d{4})[\s-](\d{4})/);
    
    if (searchMatch && candidateMatch) {
      return searchMatch[1] === candidateMatch[1] && 
             searchMatch[2] === candidateMatch[2];
    }
    
    return false;
  }

  removeAccents(text) {
    const accentMap = {
      'À': 'A', 'É': 'E', 'È': 'E', 'Ê': 'E', 'Ç': 'C',
      'Ù': 'U', 'Ô': 'O', 'Î': 'I'
    };
    
    return text.split('').map(char => accentMap[char] || char).join('');
  }
}