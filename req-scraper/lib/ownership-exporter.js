import fs from 'fs-extra';
import path from 'path';
import { stringify as csvStringify } from 'csv-stringify/sync';
import xlsx from 'xlsx';

export class OwnershipExporter {
  constructor(options = {}) {
    this.options = {
      outputDir: options.outputDir || 'output',
      format: options.format || 'both',
      logger: options.logger || console
    };
    
    this.allShareholders = [];
    this.allAdministrators = [];
    this.allBeneficiaries = [];
    this.companyOwnershipMap = new Map();
  }

  addCompanyOwnership(companyData) {
    const { 
      NEQ, 
      req_name_official, 
      shareholders = [], 
      administrators = [], 
      ultimate_beneficiaries = []
    } = companyData;
    
    const shareholdersList = typeof shareholders === 'string' ? JSON.parse(shareholders) : shareholders;
    const administratorsList = typeof administrators === 'string' ? JSON.parse(administrators) : administrators;
    const beneficiariesList = typeof ultimate_beneficiaries === 'string' ? JSON.parse(ultimate_beneficiaries) : ultimate_beneficiaries;
    
    this.companyOwnershipMap.set(NEQ, {
      company_name: req_name_official,
      NEQ: NEQ,
      shareholders: shareholdersList,
      administrators: administratorsList,
      ultimate_beneficiaries: beneficiariesList
    });
    
    shareholdersList.forEach(shareholder => {
      this.allShareholders.push({
        company_NEQ: NEQ,
        company_name: req_name_official,
        ...shareholder
      });
    });
    
    administratorsList.forEach(admin => {
      this.allAdministrators.push({
        company_NEQ: NEQ,
        company_name: req_name_official,
        ...admin
      });
    });
    
    beneficiariesList.forEach(beneficiary => {
      this.allBeneficiaries.push({
        company_NEQ: NEQ,
        company_name: req_name_official,
        ...beneficiary
      });
    });
  }

  async exportAll(baseFilename = 'ownership') {
    await fs.ensureDir(this.options.outputDir);
    
    const timestamp = new Date().toISOString().split('T')[0];
    const baseFile = path.join(this.options.outputDir, `${baseFilename}_${timestamp}`);
    
    if (this.options.format === 'csv' || this.options.format === 'both') {
      await this.exportToCSV(baseFile);
      await this.exportLongFormatCSV(baseFile);
    }
    
    if (this.options.format === 'excel' || this.options.format === 'both') {
      await this.exportToExcel(baseFile);
    }
    
    this.logStatistics();
  }

  async exportToCSV(baseFile) {
    if (this.allShareholders.length > 0) {
      const shareholdersCsv = csvStringify(this.allShareholders, {
        header: true,
        columns: ['company_NEQ', 'company_name', 'name', 'is_majority']
      });
      await fs.writeFile(`${baseFile}_shareholders.csv`, shareholdersCsv);
      this.options.logger.info(`✓ Exported ${this.allShareholders.length} shareholders to CSV`);
    }
    
    if (this.allAdministrators.length > 0) {
      const adminsCsv = csvStringify(this.allAdministrators, {
        header: true,
        columns: ['company_NEQ', 'company_name', 'full_name', 'last_name', 'first_name']
      });
      await fs.writeFile(`${baseFile}_administrators.csv`, adminsCsv);
      this.options.logger.info(`✓ Exported ${this.allAdministrators.length} administrators to CSV`);
    }
    
    if (this.allBeneficiaries.length > 0) {
      const beneficiariesCsv = csvStringify(this.allBeneficiaries, {
        header: true,
        columns: ['company_NEQ', 'company_name', 'full_name', 'last_name', 'first_name']
      });
      await fs.writeFile(`${baseFile}_ultimate_beneficiaries.csv`, beneficiariesCsv);
      this.options.logger.info(`✓ Exported ${this.allBeneficiaries.length} ultimate beneficiaries to CSV`);
    }
  }

  async exportLongFormatCSV(baseFile) {
    const allPersons = [];
    
    this.allShareholders.forEach(s => {
      allPersons.push({
        company_NEQ: s.company_NEQ,
        company_name: s.company_name,
        person_type: 'Actionnaire',
        full_name: s.name,
        is_company: s.name && s.name.includes('INC') ? 'Oui' : 'Non'
      });
    });
    
    this.allAdministrators.forEach(a => {
      allPersons.push({
        company_NEQ: a.company_NEQ,
        company_name: a.company_name,
        person_type: 'Administrateur',
        full_name: a.full_name || `${a.first_name} ${a.last_name}`.trim(),
        is_company: 'Non'
      });
    });
    
    this.allBeneficiaries.forEach(b => {
      allPersons.push({
        company_NEQ: b.company_NEQ,
        company_name: b.company_name,
        person_type: 'Bénéficiaire ultime',
        full_name: b.full_name || `${b.first_name} ${b.last_name}`.trim(),
        is_company: 'Non'
      });
    });
    
    if (allPersons.length > 0) {
      const longFormatCsv = csvStringify(allPersons, {
        header: true,
        columns: ['company_NEQ', 'company_name', 'person_type', 'full_name', 'is_company']
      });
      
      await fs.writeFile(`${baseFile}_all_persons_long_format.csv`, longFormatCsv);
      this.options.logger.info(`✓ Exported ${allPersons.length} person records in long format`);
    }
  }

  async exportToExcel(baseFile) {
    const workbook = xlsx.utils.book_new();
    
    if (this.allShareholders.length > 0) {
      const shareholdersWs = xlsx.utils.json_to_sheet(this.allShareholders);
      xlsx.utils.book_append_sheet(workbook, shareholdersWs, 'Actionnaires');
    }
    
    if (this.allAdministrators.length > 0) {
      const adminsWs = xlsx.utils.json_to_sheet(this.allAdministrators);
      xlsx.utils.book_append_sheet(workbook, adminsWs, 'Administrateurs');
    }
    
    if (this.allBeneficiaries.length > 0) {
      const beneficiariesWs = xlsx.utils.json_to_sheet(this.allBeneficiaries);
      xlsx.utils.book_append_sheet(workbook, beneficiariesWs, 'Bénéficiaires');
    }
    
    xlsx.writeFile(workbook, `${baseFile}_ownership.xlsx`);
    this.options.logger.info(`✓ Exported ownership data to Excel`);
  }

  logStatistics() {
    this.options.logger.info('═══════════════════════════════════════');
    this.options.logger.info('Ownership Export Statistics:');
    this.options.logger.info(`Companies: ${this.companyOwnershipMap.size}`);
    this.options.logger.info(`Shareholders: ${this.allShareholders.length}`);
    this.options.logger.info(`Administrators: ${this.allAdministrators.length}`);
    this.options.logger.info(`Beneficiaries: ${this.allBeneficiaries.length}`);
    this.options.logger.info('═══════════════════════════════════════');
  }
}