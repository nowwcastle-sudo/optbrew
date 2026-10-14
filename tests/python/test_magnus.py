import importlib.util
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'skills/optbrew/modules/magnus-seo/scripts/aeo_audit.py'
FIXTURE = ROOT / 'tests/fixtures/parsers/aeo.html'
spec = importlib.util.spec_from_file_location('aeo_audit', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MagnusParserTests(unittest.TestCase):
    def test_simple_jsonld_control(self):
        with tempfile.TemporaryDirectory() as directory:
            page = pathlib.Path(directory) / 'simple.html'
            page.write_text('<title>Simple</title><h1>Question?</h1><script type="application/ld+json">{"@type":"Article"}</script>', encoding='utf-8')
            result = module.audit(str(page))
        self.assertEqual(result['jsonld_types'], ['Article'])
        self.assertEqual(result['question_heading_count'], 1)

    def test_arrays_graph_nested_text_and_malformed_json(self):
        with tempfile.TemporaryDirectory() as directory:
            page = pathlib.Path(directory) / 'page.html'
            page.write_text(FIXTURE.read_text(encoding='utf-8'), encoding='utf-8')
            result = module.audit(str(page))
        self.assertEqual(result['jsonld_types'], ['Article', 'FAQPage', 'HowTo'])
        self.assertEqual(result['jsonld_blocks'], 2)
        self.assertEqual(result['jsonld_parse_errors'], 1)
        self.assertEqual(result['headings'], [{'level': 1, 'text': 'How does it work?', 'question': True}])
        self.assertEqual(result['title'], 'Guide to SEO')
        self.assertEqual(result['answer_signals']['question_marks'], 1)

    def test_inline_html_api_is_pure(self):
        result = module.audit_html('<title>Local</title><h1>Question?</h1>', 'https://example.com/p')
        self.assertEqual(result['source'], 'https://example.com/p')
        self.assertEqual(result['final_url'], 'https://example.com/p')


if __name__ == '__main__':
    unittest.main()
