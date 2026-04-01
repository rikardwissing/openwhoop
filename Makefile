add-migration:
	sea migrate -d src/btwearable-migration/ generate $(NAME)

run-migrations:
	sea migrate -d src/btwearable-migration/
	sea generate entity --output-dir src/btwearable-entities/src/ --lib

test-report:
	cargo llvm-cov --html --open

snoop-ble:
	adb shell "nc -s 127.0.0.1 -p 8872 -L system/bin/tail -f -c +0 data/misc/bluetooth/logs/btsnoop_hci.log"