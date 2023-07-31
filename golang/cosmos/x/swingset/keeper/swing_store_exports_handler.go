package keeper

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/Agoric/agoric-sdk/golang/cosmos/vm"
	"github.com/Agoric/agoric-sdk/golang/cosmos/x/swingset/types"
	vstoragetypes "github.com/Agoric/agoric-sdk/golang/cosmos/x/vstorage/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"github.com/tendermint/tendermint/libs/log"
)

// This module abstracts the generation and handling of swing-store exports,
// including the communication with the JS side to generate and restore them.
//
// Its interface derives from the following requirements:
// - Multiple golang components may perform swing-store export or import
//   operations, but the JS side does not support concurrent operations as
//   there are no legitimate use cases.
// - Some components cannot block the main execution while performing an export
//   operation. In particular, cosmos's state-sync snapshot process cannot
//   block the logic handling tendermint events.
// - The JS swing-store cannot access historical states. To generate
//   deterministic exports, the export operations that cannot block must be able
//   to synchronize with commit points that will change the JS swing-store.
// - The JS swing-store export logic does however support mutation of the state
//   after an export operation has started, even if it has not yet completed.
//   This implies the synchronization is only necessary until the JS side of
//   the export operation has started.
// - Some components, in particular state-sync, may need to perform other work
//   alongside generating a swing-store export. This work similarly cannot block
//   the main execution, but must allow for the swing-store synchronization
//   that enables generating deterministic export. For state-sync, this work
//   happens before the generated swing-store export can be consumed.
//
// The general approach taken is to implement a SwingStoreExportsHandler that
// implements the communication with the JS side, enforces that no concurrent
// operations take place, defers the consumption of the export to a provided
// SwingStoreExportEventHandler, and provides some synchronization methods to
// let the application enforce mutation boundaries.
//
// There should be a single SwingStoreExportHandler instance, and all its method
// calls should be performed from the same thread (no mutex enforcement).
//
// The process of generating a SwingStore export proceeds as follow:
// - The component invokes swingStoreExportsHandler.InitiateExport with an
//   eventHandler for the export.
// - InitiateExport verifies no other export operation is in progress and
//   starts a goroutine to perform the export operation. It requests the JS
//   side to start generating an export of the swing-store, and calls the
//   eventHandler's ExportInitiated method with a function param allowing it to
//   retrieve the export.
// - The cosmos app will call WaitUntilSwingStoreExportStarted before
//   instructing the JS controller to commit its work, satisfying the
//   deterministic exports requirement.
// - ExportInitiated must call the retrieve function before returning, however
//   it may perform other work before. For cosmos state-sync snapshots,
//   ExportInitiated will call app.Snapshot which will invoke the swingset
//   module's ExtensionSnapshotter that will retrieve and process the
//   swing-store export.
// - When the retrieve function is called, it blocks until the JS export is
//   ready, then creates a SwingStoreExportProvider that abstract accessing
//   the content of the export. The eventHandler's ExportRetrieved is called
//   with the export provider.
// - ExportRetrieved reads the export using the provider.
//
// Restoring a swing-store export does not have similar non-blocking requirements.
// The component simply invokes swingStoreExportHandler.RestoreExport with a
// SwingStoreExportProvider representing the swing-store export to
// be restored, and RestoreExport will consume it and block until the JS side
// has completed the restore before returning.

// ExportManifestFilename is the manifest filename which must be synchronized with the JS export/import tooling
// See packages/cosmic-swingset/src/export-kernel-db.js and packages/cosmic-swingset/src/import-kernel-db.js
const ExportManifestFilename = "export-manifest.json"

// UntrustedExportDataArtifactName is a special artifact name that the provider and consumer of an export can
// use to indicate the presence of a synthetic artifact containing untrusted "export data". This artifact must
// not end up in the list of artifacts imported by the JS import tooling (which would fail).
const UntrustedExportDataArtifactName = "UNTRUSTED-EXPORT-DATA"

// For export operations, the swing-store "export data" is exchanged with the
// JS side as a file which encodes "export data" entries as a sequence of
// [key, value] JSON arrays each terminated by a new line.
// NB: this is not technically jsonlines since the entries are new line
// terminated instead of being new line separated, however the parsers in both
// JS and golang handle such extra whitespace.
const exportDataFilename = "export-data.jsonl"
const untrustedExportDataFilename = "untrusted-export-data.jsonl"
const exportedFilesMode = 0644

type exportManifest struct {
	// BlockHeight is the block height of the manifest.
	BlockHeight uint64 `json:"blockHeight,omitempty"`
	// Data is the filename of the export data.
	Data string `json:"data,omitempty"`
	// Artifacts is the list of [artifact name, file name] pairs.
	Artifacts [][2]string `json:"artifacts"`
}

var disallowedArtifactNameChar = regexp.MustCompile(`[^-_.a-zA-Z0-9]`)

// sanitizeArtifactName searches a string for all characters
// other than ASCII alphanumerics, hyphens, underscores, and dots,
// and replaces each of them with a hyphen.
func sanitizeArtifactName(name string) string {
	return disallowedArtifactNameChar.ReplaceAllString(name, "-")
}

type operationDetails struct {
	// isRestore indicates whether the operation in progress is a restore.
	isRestore bool
	// blockHeight is the block height of this in-progress operation.
	blockHeight uint64
	// logger is the destination for this operation's log messages.
	logger log.Logger
	// exportStartedResult is used to synchronize the commit boundary by the
	// component performing the export operation to ensure export determinism
	// unused for restore operations
	exportStartedResult chan error
	// exportRetrieved is an internal flag indicating whether the JS generated
	// export was retrieved. It can be false regardless of the component's
	// eventHandler reporting an error or not. It is only indicative of whether
	// the component called retrieveExport, and used to control whether to send
	// a discard request if the JS side stayed responsible for the generated but
	// un-retrieved export.
	// It is only read or written by the export operation's goroutine.
	exportRetrieved bool
	// exportDone is a channel that is closed when the active export operation
	// is complete.
	exportDone chan error
}

// Only modified by the main goroutine.
var activeOperation *operationDetails

// WaitUntilSwingStoreExportStarted synchronizes with an export operation in
// progress, if any.
// The JS swing-store export must have started before a new block is committed
// to ensure the content of the export is the one expected. The app must call
// this method before sending a commit action to the JS controller.
//
// Waits for a just initiated export operation to have started in its goroutine.
// If no operation is in progress (InitiateExport hasn't been called or
// already completed), or if we previously checked if the operation had started,
// returns immediately.
func WaitUntilSwingStoreExportStarted() error {
	operationDetails := activeOperation
	if operationDetails == nil {
		return nil
	}
	// Block until the active operation has started, saving the result.
	// The operation's goroutine only produces a value in case of an error,
	// and closes the channel once the export has started or failed.
	// Only the first call after an export was initiated will report an error.
	startErr := <-operationDetails.exportStartedResult

	// Check if the active export operation is done, and if so, nil it out so
	// future calls are faster.
	select {
	case <-operationDetails.exportDone:
		activeOperation = nil
	default:
		// don't wait for it to finish
	}

	return startErr
}

// WaitUntilSwingStoreExportDone synchronizes with the completion of an export
// operation in progress, if any.
// Only a single SwingStore operation may execute at a time. Calling
// InitiateExport or RestoreExport will fail if a swing-store operation is
// already in progress. Furthermore, a component may need to know once an
// export it initiated has completed. Once this method call returns, the
// goroutine is guaranteed to have terminated, and the SwingStoreExportEventHandler
// provided to InitiateExport to no longer be in use.
//
// Reports any error that may have occurred from InitiateExport.
// If no export operation is in progress (InitiateExport hasn't been called or
// already completed), or if we previously checked if an export had completed,
// returns immediately.
func WaitUntilSwingStoreExportDone() error {
	operationDetails := activeOperation
	if operationDetails == nil {
		return nil
	}
	// Block until the active export has completed.
	// The export operation's goroutine only produces a value in case of an error,
	// and closes the channel once the export has completed or failed.
	// Only the first call after an export was initiated will report an error.
	exportErr := <-operationDetails.exportDone
	activeOperation = nil

	return exportErr
}

// checkNotActive returns an error if there is an active operation.
func checkNotActive() error {
	operationDetails := activeOperation
	if operationDetails != nil {
		select {
		case <-operationDetails.exportDone:
			activeOperation = nil
		default:
			if operationDetails.isRestore {
				return fmt.Errorf("restore operation already in progress for height %d", operationDetails.blockHeight)
			} else {
				return fmt.Errorf("export operation already in progress for height %d", operationDetails.blockHeight)
			}
		}
	}
	return nil
}

// SwingStoreExportProvider gives access to a SwingStore export data and the
// related artifacts.
// The abstraction is similar to the JS side swing-store export abstraction,
// but without the ability to list artifacts or random access them.
type SwingStoreExportProvider struct {
	// BlockHeight is the block height of the SwingStore export.
	BlockHeight uint64
	// GetExportData is a function to return the "export data" of the SwingStore export, if any.
	// It errors with io.EOF if the export contains no "export data".
	GetExportData func() ([]*vstoragetypes.DataEntry, error)
	// ReadArtifact is a function to return the next unread artifact in the SwingStore export.
	// It errors with io.EOF upon reaching the end of the artifact list.
	ReadArtifact func() (types.SwingStoreArtifact, error)
}

// SwingStoreExportEventHandler is used to handle events that occur while generating
// a swing-store export. It defines the mandatory interface of the component
// handling these events, and which is provided to InitiateExport.
type SwingStoreExportEventHandler interface {
	// ExportInitiated is called by InitiateExport in a goroutine after the
	// swing-store export was initiated.
	// This is where the component performing the export must initiate its own
	// off main thread work, which results in retrieving and processing the
	// swing-store export.
	//
	// Must call the retrieveExport function before returning, which will in turn
	// synchronously invoke ExportRetrieved once the swing-store export is ready.
	ExportInitiated(blockHeight uint64, retrieveExport func() error) error
	// ExportRetrieved is called when the swing-store export has been retrieved,
	// during the retrieveExport invocation.
	// The provider is not a return value to retrieveExport in order to
	// report errors in components that are unable to propagate errors back to the
	// ExportInitiated result, like cosmos state-sync ExtensionSnapshotter.
	// The implementation must synchronously consume the provider, which becomes
	// invalid after the method returns.
	ExportRetrieved(provider SwingStoreExportProvider) error
}

type swingStoreExportAction struct {
	Type        string            `json:"type"` // SWING_STORE_EXPORT
	BlockHeight uint64            `json:"blockHeight,omitempty"`
	Request     string            `json:"request"` // "initiate", "discard", "retrieve", or "restore"
	Args        []json.RawMessage `json:"args,omitempty"`
}

// SwingStoreExportOptions are configurable options provided to the JS swing-store export
type SwingStoreExportOptions struct {
	// The export mode can be "current", "archival" or "debug"
	// See packages/cosmic-swingset/src/export-kernel-db.js initiateSwingStoreExport and
	// packages/swing-store/src/swingStore.js makeSwingStoreExporter
	ExportMode string `json:"exportMode,omitempty"`
	// A flag indicating whether "export data" should be part of the swing-store export
	// If false, the resulting SwingStoreExportProvider's GetExportData will
	// error with io.EOF
	IncludeExportData bool `json:"includeExportData,omitempty"`
}

// SwingStoreRestoreOptions are configurable options provided to the JS swing-store import
type SwingStoreRestoreOptions struct {
	// A flag indicating whether the swing-store import should attempt to load
	// all historical artifacts available from the export provider
	IncludeHistorical bool `json:"includeHistorical,omitempty"`
}

type swingStoreImportOptions struct {
	ExportDir         string `json:"exportDir"`
	IncludeHistorical bool   `json:"includeHistorical,omitempty"`
}

// SwingStoreExportsHandler exclusively manages the communication with the JS side
// related to swing-store exports, ensuring insensitivity to sub-block timing,
// and enforcing concurrency requirements.
// The caller of this submodule must arrange block level commit synchronization,
// to ensure the results are deterministic.
//
// Some blockingSend calls performed by this submodule are non-deterministic.
// This submodule will send messages to JS from goroutines at unpredictable
// times, but this is safe because when handling the messages, the JS side
// does not perform operations affecting consensus and ignores state changes
// since committing the previous block.
// Some other blockingSend calls however do change the JS swing-store and
// must happen before the Swingset controller on the JS side was inited, in
// which case the mustNotBeInited parameter will be set to true.
type SwingStoreExportsHandler struct {
	logger       log.Logger
	blockingSend func(action vm.Jsonable, mustNotBeInited bool) (string, error)
}

// NewSwingStoreExportsHandler creates a SwingStoreExportsHandler
func NewSwingStoreExportsHandler(logger log.Logger, blockingSend func(action vm.Jsonable, mustNotBeInited bool) (string, error)) *SwingStoreExportsHandler {
	return &SwingStoreExportsHandler{
		logger:       logger.With("module", fmt.Sprintf("x/%s", types.ModuleName), "submodule", "SwingStoreExportsHandler"),
		blockingSend: blockingSend,
	}
}

// InitiateExport synchronously verifies that there is not already an export or
// import operation in progress and initiates a new export in a goroutine,
// delegating some of the process to the provided eventHandler.
//
// eventHandler is invoked solely from the spawned goroutine.
// The "started" and "done" events can be used for synchronization with an
// active operation taking place in the goroutine, by calling respectively the
// WaitUntilSwingStoreExportStarted and WaitUntilSwingStoreExportDone methods
// from the thread that initiated the export.
func (exportsHandler SwingStoreExportsHandler) InitiateExport(blockHeight uint64, eventHandler SwingStoreExportEventHandler, exportOptions SwingStoreExportOptions) error {
	err := checkNotActive()
	if err != nil {
		return err
	}

	encodedExportOptions, err := json.Marshal(exportOptions)
	if err != nil {
		return err
	}

	var logger log.Logger
	if blockHeight != 0 {
		logger = exportsHandler.logger.With("height", blockHeight)
	} else {
		logger = exportsHandler.logger.With("height", "latest")

	}

	// Indicate that an export operation has been initiated by setting the global
	// activeOperation var.
	// This structure is used to synchronize with the goroutine spawned below.
	operationDetails := &operationDetails{
		blockHeight:         blockHeight,
		logger:              logger,
		exportStartedResult: make(chan error, 1),
		exportRetrieved:     false,
		exportDone:          make(chan error, 1),
	}
	activeOperation = operationDetails

	go func() {
		var err error
		defer func() {
			if err != nil {
				operationDetails.exportDone <- err
			}
			close(operationDetails.exportDone)
		}()

		action := &swingStoreExportAction{
			Type:        "SWING_STORE_EXPORT",
			BlockHeight: blockHeight,
			Request:     "initiate",
			Args:        []json.RawMessage{encodedExportOptions},
		}

		// blockingSend for SWING_STORE_EXPORT action is safe to call from a goroutine
		_, err = exportsHandler.blockingSend(action, false)

		if err != nil {
			// First indicate an export is no longer in progress if the call to
			// WaitUntilSwingStoreExportStarted has't happened yet.
			// Then signal the current export operation if a call to
			// WaitUntilSwingStoreExportStarted was already waiting.
			operationDetails.exportStartedResult <- err
			close(operationDetails.exportStartedResult)
			logger.Error("failed to initiate swing-store export", "err", err)
			return
		}

		// Signal that the export operation has started in the goroutine. Calls to
		// WaitUntilSwingStoreExportStarted will no longer block.
		close(operationDetails.exportStartedResult)

		// The user provided ExportStarted function should call retrieveExport()
		var retrieveErr error
		err = eventHandler.ExportInitiated(blockHeight, func() error {
			activeOperationDetails := activeOperation
			if activeOperationDetails != operationDetails || operationDetails.exportRetrieved {
				// shouldn't happen, but return an error if it does
				return errors.New("export operation no longer active")
			}

			retrieveErr = exportsHandler.retrieveExport(eventHandler.ExportRetrieved)

			return retrieveErr
		})

		// Restore any retrieve error swallowed by ExportStarted
		if err == nil {
			err = retrieveErr
		}
		if err != nil {
			logger.Error("failed to process swing-store export", "err", err)
		}

		// Check whether the JS generated export was retrieved by eventHandler
		if operationDetails.exportRetrieved {
			return
		}

		// Discarding the export so invalidate retrieveExport
		operationDetails.exportRetrieved = true

		action = &swingStoreExportAction{
			Type:        "SWING_STORE_EXPORT",
			BlockHeight: blockHeight,
			Request:     "discard",
		}
		_, discardErr := exportsHandler.blockingSend(action, false)

		if discardErr != nil {
			logger.Error("failed to discard swing-store export", "err", err)
		}

		if err == nil {
			err = discardErr
		} else if discardErr != nil {
			// Safe to wrap error and use detailed error info since this error
			// will not go back into swingset layers
			err = sdkerrors.Wrapf(err, "failed to discard swing-store export after failing to process export: %+v", discardErr)
		}
	}()

	return nil
}

// retrieveExport retrieves an initiated export and calls exportRetrieved with
// the retrieved export.
//
// This will block until the export is ready. Internally invoked by the
// InitiateExport logic in the export operation's goroutine.
func (exportsHandler SwingStoreExportsHandler) retrieveExport(exportRetrieved func(provider SwingStoreExportProvider) error) (err error) {
	operationDetails := activeOperation
	if operationDetails == nil {
		// shouldn't happen, but return an error if it does
		return errors.New("no active swing-store export operation")
	}

	blockHeight := operationDetails.blockHeight

	action := &swingStoreExportAction{
		Type:        "SWING_STORE_EXPORT",
		BlockHeight: blockHeight,
		Request:     "retrieve",
	}
	out, err := exportsHandler.blockingSend(action, false)

	if err != nil {
		return err
	}
	operationDetails.exportRetrieved = true

	var exportDir string
	err = json.Unmarshal([]byte(out), &exportDir)
	if err != nil {
		return err
	}

	defer os.RemoveAll(exportDir)

	rawManifest, err := os.ReadFile(filepath.Join(exportDir, ExportManifestFilename))
	if err != nil {
		return err
	}

	var manifest exportManifest
	err = json.Unmarshal(rawManifest, &manifest)
	if err != nil {
		return err
	}

	if blockHeight != 0 && manifest.BlockHeight != blockHeight {
		return fmt.Errorf("export manifest blockHeight (%d) doesn't match (%d)", manifest.BlockHeight, blockHeight)
	}

	getExportData := func() ([]*vstoragetypes.DataEntry, error) {
		if manifest.Data == "" {
			return nil, io.EOF
		}

		dataFile, err := os.Open(filepath.Join(exportDir, manifest.Data))
		if err != nil {
			return nil, err
		}
		defer dataFile.Close()

		entries := []*vstoragetypes.DataEntry{}
		decoder := json.NewDecoder(dataFile)
		for {
			var jsonEntry []string
			err = decoder.Decode(&jsonEntry)
			if err == io.EOF {
				break
			} else if err != nil {
				return nil, err
			}

			if len(jsonEntry) != 2 {
				return nil, fmt.Errorf("invalid export data entry (length %d)", len(jsonEntry))
			}
			entry := vstoragetypes.DataEntry{Path: jsonEntry[0], Value: jsonEntry[1]}
			entries = append(entries, &entry)
		}

		return entries, nil
	}

	nextArtifact := 0

	readArtifact := func() (artifact types.SwingStoreArtifact, err error) {
		if nextArtifact == len(manifest.Artifacts) {
			return artifact, io.EOF
		} else if nextArtifact > len(manifest.Artifacts) {
			return artifact, fmt.Errorf("exceeded expected artifact count: %d > %d", nextArtifact, len(manifest.Artifacts))
		}

		artifactEntry := manifest.Artifacts[nextArtifact]
		nextArtifact++

		artifactName := artifactEntry[0]
		fileName := artifactEntry[1]
		if artifactName == UntrustedExportDataArtifactName {
			return artifact, fmt.Errorf("unexpected export artifact name %s", artifactName)
		}
		artifact.Name = artifactName
		artifact.Data, err = os.ReadFile(filepath.Join(exportDir, fileName))

		return artifact, err
	}

	err = exportRetrieved(SwingStoreExportProvider{BlockHeight: manifest.BlockHeight, GetExportData: getExportData, ReadArtifact: readArtifact})
	if err != nil {
		return err
	}

	// if nextArtifact != len(manifest.Artifacts) {
	// 	return errors.New("not all export artifacts were retrieved")
	// }

	operationDetails.logger.Info("retrieved swing-store export", "exportDir", exportDir)

	return nil
}

// RestoreExport restores the JS swing-store using previously exported data and artifacts.
func (exportsHandler SwingStoreExportsHandler) RestoreExport(provider SwingStoreExportProvider, restoreOptions SwingStoreRestoreOptions) error {
	err := checkNotActive()
	if err != nil {
		return err
	}

	blockHeight := provider.BlockHeight

	// We technically don't need to create an active operation here since both
	// InitiateExport and RestoreExport should only be called from the main
	// thread, but it doesn't cost much to add in case things go wrong.
	operationDetails := &operationDetails{
		isRestore:   true,
		blockHeight: blockHeight,
		logger:      exportsHandler.logger,
		// goroutine synchronization is unnecessary since anything checking should
		// be called from the same thread.
		// Effectively WaitUntilSwingStoreExportStarted would block infinitely and
		// exportsHandler.InitiateExport will error when calling checkNotActive.
		exportStartedResult: nil,
		exportDone:          nil,
	}
	activeOperation = operationDetails
	defer func() {
		activeOperation = nil
	}()

	exportDir, err := os.MkdirTemp("", fmt.Sprintf("agd-swing-store-restore-%d-*", blockHeight))
	if err != nil {
		return err
	}
	defer os.RemoveAll(exportDir)

	manifest := exportManifest{
		BlockHeight: blockHeight,
	}

	exportDataEntries, err := provider.GetExportData()

	if err == nil {
		manifest.Data = exportDataFilename
		exportDataFile, err := os.OpenFile(filepath.Join(exportDir, exportDataFilename), os.O_CREATE|os.O_WRONLY, exportedFilesMode)
		if err != nil {
			return err
		}
		defer exportDataFile.Close()

		encoder := json.NewEncoder(exportDataFile)
		encoder.SetEscapeHTML(false)
		for _, dataEntry := range exportDataEntries {
			entry := []string{dataEntry.Path, dataEntry.Value}
			err := encoder.Encode(entry)
			if err != nil {
				return err
			}
		}

		err = exportDataFile.Sync()
		if err != nil {
			return err
		}
	} else if err != io.EOF {
		return err
	}

	writeExportFile := func(filename string, data []byte) error {
		return os.WriteFile(filepath.Join(exportDir, filename), data, exportedFilesMode)
	}

	for {
		artifact, err := provider.ReadArtifact()
		if err == io.EOF {
			break
		} else if err != nil {
			return err
		}

		if artifact.Name != UntrustedExportDataArtifactName {
			// Artifact verifiable on import from the export data
			// Since we cannot trust the state-sync artifact at this point, we generate
			// a safe and unique filename from the artifact name we received, by
			// substituting any non letters-digits-hyphen-underscore-dot by a hyphen,
			// and prefixing with an incremented id.
			// The filename is not used for any purpose in the export logic.
			filename := sanitizeArtifactName(artifact.Name)
			filename = fmt.Sprintf("%d-%s", len(manifest.Artifacts), filename)
			manifest.Artifacts = append(manifest.Artifacts, [2]string{artifact.Name, filename})
			err = writeExportFile(filename, artifact.Data)
		} else {
			// Pseudo artifact containing untrusted export data which may have been
			// saved separately for debugging purposes (not referenced from the manifest)
			err = writeExportFile(untrustedExportDataFilename, artifact.Data)
		}
		if err != nil {
			return err
		}
	}

	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	err = writeExportFile(ExportManifestFilename, manifestBytes)
	if err != nil {
		return err
	}

	importOptions := swingStoreImportOptions{
		ExportDir:         exportDir,
		IncludeHistorical: restoreOptions.IncludeHistorical,
	}

	encodedImportOptions, err := json.Marshal(importOptions)
	if err != nil {
		return err
	}

	action := &swingStoreExportAction{
		Type:        "SWING_STORE_EXPORT",
		BlockHeight: blockHeight,
		Request:     "restore",
		Args:        []json.RawMessage{encodedImportOptions},
	}

	_, err = exportsHandler.blockingSend(action, true)
	if err != nil {
		return err
	}

	exportsHandler.logger.Info("restored swing-store export", "exportDir", exportDir, "height", blockHeight)

	return nil
}
